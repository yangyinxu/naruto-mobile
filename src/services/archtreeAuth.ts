export const DEFAULT_NARUTO_PROXY_BASE_URL = 'https://kashewt.com/naruto-mobile/api/v1';

export interface ArchtreeAccount {
  userId: string;
  email: string;
  role: 'admin' | 'user';
}

export interface StoredArchtreeSession extends ArchtreeAccount {
  version: 1;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface RuntimeArchtreeSession extends StoredArchtreeSession {
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

interface SessionResponse {
  accessToken?: unknown;
  refreshToken?: unknown;
  accessTokenExpiresIn?: unknown;
  refreshTokenExpiresAt?: unknown;
  userId?: unknown;
  email?: unknown;
  role?: unknown;
  message?: unknown;
  code?: unknown;
}

export type PersistArchtreeSession = (session: StoredArchtreeSession | undefined) => Promise<void>;

export class ArchtreeAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable = false
  ) {
    super(message);
  }
}

export interface ArchtreeAuthOptions {
  proxyBaseUrl?: string;
  initialSession?: unknown;
  persistSession?: PersistArchtreeSession;
  fetchImpl?: typeof fetch;
}

const normalizedProxyBaseUrl = (value: string) => {
  const url = new URL(value);
  const localDevelopment = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password) {
    throw new Error('Archtree 登录地址必须使用 HTTPS。');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
};

const validExpiry = (value: unknown) => typeof value === 'string'
  && Number.isFinite(Date.parse(value));

/** Validates decrypted storage before any credential is accepted into memory. */
export const parseStoredArchtreeSession = (value: unknown): StoredArchtreeSession | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<StoredArchtreeSession>;
  if (
    candidate.version !== 1
    || typeof candidate.userId !== 'string'
    || !/^[a-f0-9]{24}$/.test(candidate.userId)
    || typeof candidate.email !== 'string'
    || candidate.email.length > 320
    || (candidate.role !== 'admin' && candidate.role !== 'user')
    || typeof candidate.refreshToken !== 'string'
    || candidate.refreshToken.length < 32
    || candidate.refreshToken.length > 512
    || typeof candidate.refreshTokenExpiresAt !== 'string'
    || !validExpiry(candidate.refreshTokenExpiresAt)
    || Date.parse(candidate.refreshTokenExpiresAt) <= Date.now()
  ) return undefined;
  const {version, userId, email, role, refreshToken, refreshTokenExpiresAt} = candidate;
  return {version, userId, email, role, refreshToken, refreshTokenExpiresAt} as StoredArchtreeSession;
};

const boundedToken = (value: unknown, maximum: number) => (
  typeof value === 'string' && value.length >= 32 && value.length <= maximum ? value : undefined
);

/** Owns the native Archtree session, including single-flight refresh rotation. */
export class ArchtreeAuthService {
  private readonly fetchImpl: typeof fetch;
  private readonly persistSession: PersistArchtreeSession;
  private readonly proxyBaseUrl: string;
  private readonly archtreeOrigin: string;
  private session?: RuntimeArchtreeSession;
  private refreshPromise?: Promise<string>;
  private logoutPromise?: Promise<void>;
  private loggingIn = false;
  private signingOut = false;

  constructor(options: ArchtreeAuthOptions = {}) {
    this.proxyBaseUrl = normalizedProxyBaseUrl(
      options.proxyBaseUrl ?? DEFAULT_NARUTO_PROXY_BASE_URL
    );
    this.archtreeOrigin = new URL(this.proxyBaseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.persistSession = options.persistSession ?? (async () => undefined);
    this.session = parseStoredArchtreeSession(options.initialSession);
  }

  get account(): ArchtreeAccount | undefined {
    if (!this.session || Date.parse(this.session.refreshTokenExpiresAt) <= Date.now()) return undefined;
    const {userId, email, role} = this.session;
    return {userId, email, role};
  }

  get signedIn() {
    return Boolean(this.account);
  }

  private async json(response: Response) {
    return response.json().catch(() => ({})) as Promise<SessionResponse>;
  }

  private sessionFrom(value: SessionResponse, account?: ArchtreeAccount): RuntimeArchtreeSession {
    const accessToken = boundedToken(value.accessToken, 8_192);
    const refreshToken = boundedToken(value.refreshToken, 512);
    const accessTokenExpiresIn = Number(value.accessTokenExpiresIn);
    const refreshTokenExpiresAt = value.refreshTokenExpiresAt;
    const userId = account?.userId ?? value.userId;
    const email = account?.email ?? value.email;
    const role = account?.role ?? value.role;
    if (
      !accessToken
      || !refreshToken
      || !Number.isFinite(accessTokenExpiresIn)
      || accessTokenExpiresIn < 1
      || accessTokenExpiresIn > 3_600
      || typeof refreshTokenExpiresAt !== 'string'
      || !validExpiry(refreshTokenExpiresAt)
      || Date.parse(refreshTokenExpiresAt) <= Date.now()
      || typeof userId !== 'string'
      || !/^[a-f0-9]{24}$/.test(userId)
      || typeof email !== 'string'
      || email.length > 320
      || (role !== 'admin' && role !== 'user')
    ) throw new ArchtreeAuthError('Archtree 返回了不兼容的登录会话。', 502, true);
    return {
      version: 1,
      userId,
      email,
      role,
      accessToken,
      accessTokenExpiresAt: Date.now() + accessTokenExpiresIn * 1_000,
      refreshToken,
      refreshTokenExpiresAt
    };
  }

  private stored(session: RuntimeArchtreeSession): StoredArchtreeSession {
    const {version, userId, email, role, refreshToken, refreshTokenExpiresAt} = session;
    return {version, userId, email, role, refreshToken, refreshTokenExpiresAt};
  }

  private async revoke(refreshToken: string) {
    await this.fetchImpl(`${this.archtreeOrigin}/auth/logout`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({refreshToken}),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    }).catch(() => undefined);
  }

  async login(identifierValue: string, password: string) {
    if (this.logoutPromise) await this.logoutPromise;
    if (this.signedIn || this.refreshPromise || this.loggingIn) {
      throw new ArchtreeAuthError('请先退出当前 Archtree 账号再重新登录。', 409);
    }
    const identifier = identifierValue.trim();
    if (!identifier || identifier.length > 320 || !password || password.length > 256) {
      throw new ArchtreeAuthError('请输入有效的 Archtree 邮箱或用户名和密码。', 400);
    }
    this.loggingIn = true;
    try {
      const response = await this.fetchImpl(`${this.archtreeOrigin}/auth/login`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({identifier, password}),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000)
      });
      const value = await this.json(response);
      if (!response.ok) {
        const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : 401;
        throw new ArchtreeAuthError(
          typeof value.message === 'string' ? value.message : 'Archtree 登录失败。',
          status,
          status === 429 || status === 503
        );
      }
      const candidate = this.sessionFrom(value);
      try {
        await this.persistSession(this.stored(candidate));
      } catch (error) {
        await this.revoke(candidate.refreshToken);
        throw error;
      }
      this.session = candidate;
      return this.account!;
    } finally {
      this.loggingIn = false;
    }
  }

  /** Confirms a restored or current session immediately before paid analysis work. */
  async ensureAccess() {
    if (!this.signedIn) throw new ArchtreeAuthError('请先登录 Archtree 账号。', 401);
    const response = await this.request(`${this.proxyBaseUrl}/access`, {
      signal: AbortSignal.timeout(20_000)
    });
    if (response.ok) {
      const account = this.account;
      if (!account || this.signingOut) {
        throw new ArchtreeAuthError('请先登录 Archtree 账号。', 401);
      }
      return account;
    }
    const status = response.status === 401 ? 401 : response.status === 429 ? 429 : 503;
    if (status === 401) {
      const current = this.session;
      if (current) await this.revoke(current.refreshToken);
      this.session = undefined;
      await this.persistSession(undefined).catch(() => undefined);
    }
    throw new ArchtreeAuthError(
      status === 401 ? 'Archtree 登录已失效，请重新登录。' : 'Archtree 调查服务暂时不可用，请稍后重试。',
      status,
      status === 429 || status === 503
    );
  }

  logout() {
    if (this.logoutPromise) return this.logoutPromise;
    this.logoutPromise = this.logoutOnce().finally(() => {
      this.logoutPromise = undefined;
    });
    return this.logoutPromise;
  }

  private async logoutOnce() {
    this.signingOut = true;
    try {
      await this.refreshPromise?.catch(() => undefined);
      const current = this.session;
      if (!current) return;
      await this.persistSession(undefined);
      this.session = undefined;
      await this.revoke(current.refreshToken);
    } finally {
      this.signingOut = false;
    }
  }

  private async rotate(staleAccessToken?: string) {
    if (this.signingOut) throw new ArchtreeAuthError('正在退出 Archtree，请稍后重新登录。', 401);
    if (
      staleAccessToken
      && this.session?.accessToken
      && this.session.accessToken !== staleAccessToken
    ) return this.session.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.rotateOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async rotateOnce() {
    const current = this.session;
    if (!current) throw new ArchtreeAuthError('请先登录 Archtree 账号。', 401);
    const response = await this.fetchImpl(`${this.archtreeOrigin}/auth/refresh`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({refreshToken: current.refreshToken}),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    });
    const value = await this.json(response);
    if (!response.ok) {
      if (response.status === 401) {
        this.session = undefined;
        await this.persistSession(undefined);
        throw new ArchtreeAuthError('Archtree 登录已失效，请重新登录。', 401);
      }
      throw new ArchtreeAuthError(
        '暂时无法刷新 Archtree 登录，请稍后重试。',
        response.status === 429 ? 429 : 503,
        true
      );
    }
    const next = this.sessionFrom(value, current);
    try {
      await this.persistSession(this.stored(next));
    } catch (error) {
      this.session = undefined;
      await this.persistSession(undefined).catch(() => undefined);
      throw error;
    }
    this.session = next;
    return next.accessToken!;
  }

  private async currentAccessToken() {
    if (this.signingOut) throw new ArchtreeAuthError('正在退出 Archtree，请稍后重新登录。', 401);
    const current = this.session;
    if (!current) throw new ArchtreeAuthError('请先登录 Archtree 账号。', 401);
    if (
      current.accessToken
      && current.accessTokenExpiresAt
      && current.accessTokenExpiresAt > Date.now() + 30_000
    ) return current.accessToken;
    return this.rotate();
  }

  /** Sends credentials only to the configured Archtree origin and retries once after rotation. */
  async request(input: string | URL | Request, init: RequestInit = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const proxyPath = new URL(this.proxyBaseUrl).pathname.replace(/\/$/, '');
    const pathAllowed = url.pathname === proxyPath || url.pathname.startsWith(`${proxyPath}/`);
    if (url.origin !== this.archtreeOrigin || !pathAllowed) {
      throw new Error('拒绝把 Archtree 登录发送到未配置的地址。');
    }
    const send = async (accessToken: string) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${accessToken}`);
      return this.fetchImpl(url, {...init, headers, redirect: 'error'});
    };
    const initialToken = await this.currentAccessToken();
    const response = await send(initialToken);
    if (response.status !== 401) return response;
    return send(await this.rotate(initialToken));
  }
}
