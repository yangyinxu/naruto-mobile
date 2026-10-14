import type {AccountViewer} from './types';
import {object, text} from './validation';

export const LOGIN_URL = '/auth/login-web?returnTo=%2Fnaruto%2F';
export const ACCOUNT_URL = '/finitude/account';
const sessionChannel = 'finitude:browser-session-change';

/** Uses only the authoritative HttpOnly browser session, with a fixed viewer per analysis invocation. */
export class BrowserAnalysisSession {
  private revision = 0;
  private viewer?: AccountViewer;
  private transition = new AbortController();
  private channel?: BroadcastChannel;
  private refreshInFlight?: {revision: number; promise: Promise<AccountViewer | undefined>};
  private readonly observedEvents = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private enabled?: boolean;

  constructor(fetchImpl: typeof fetch = fetch, private readonly page?: Window,
    private readonly sessionLocks: LockManager | undefined = globalThis.navigator?.locks) {
    // Native browser fetch requires the global receiver, even when supplied through dependency injection.
    this.fetchImpl = fetchImpl.bind(globalThis);
    if (page && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(sessionChannel);
      this.channel.onmessage = (event) => this.receiveTransition(event.data);
    }
    page?.addEventListener('storage', (event) => {
      if (event.key === sessionChannel && event.newValue && event.newValue.length < 2000) {
        try {this.receiveTransition(JSON.parse(event.newValue));} catch { /* Ignore malformed unrelated events. */ }
      }
    });
    page?.addEventListener('focus', () => {void this.account().catch(() => undefined);});
  }

  get currentAccount() {return this.viewer;}
  get serviceEnabled() {return this.enabled;}

  private publishSnapshot() {
    this.page?.dispatchEvent(new CustomEvent('naruto:analysis-account-change', {detail: {account: this.viewer}}));
  }

  private receiveTransition(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const event = value as {id?: unknown; reason?: unknown};
    if (typeof event.id !== 'string' || !event.id || event.id.length > 200 || this.observedEvents.has(event.id)
      || !['login', 'logout', 'logout-all', 'account-deleted', 'viewer-mismatch'].includes(String(event.reason))) return;
    if (this.observedEvents.size > 100) this.observedEvents.clear();
    this.observedEvents.add(event.id);
    this.invalidate();
  }

  invalidate(reason?: 'logout' | 'viewer-mismatch') {
    const hadViewer = Boolean(this.viewer);
    this.viewer = undefined;
    this.revision += 1;
    this.transition.abort();
    this.transition = new AbortController();
    if (hadViewer) this.publishSnapshot();
    if (reason) {
      const event = {id: crypto.randomUUID(), reason};
      this.observedEvents.add(event.id);
      this.channel?.postMessage(event);
      try {this.page?.localStorage.setItem(sessionChannel, JSON.stringify(event));} catch { /* Local invalidation already succeeded. */ }
    }
  }

  async status() {
    const response = await this.fetchImpl('/naruto/api/v1/status', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('分析服务暂时不可用，本机调查数据不受影响。');
    const value = object(await response.json());
    if (value.protocolVersion !== 1 || value.model !== 'gpt-6-luna' || typeof value.enabled !== 'boolean') {
      throw new Error('网页版分析服务版本不兼容。');
    }
    this.enabled = value.enabled;
    return {enabled: value.enabled, model: 'gpt-6-luna', maxConcurrentRequests: Math.min(12,
      typeof value.maxConcurrentRequests === 'number' && Number.isInteger(value.maxConcurrentRequests)
        && value.maxConcurrentRequests > 0 ? value.maxConcurrentRequests : 12)};
  }

  async account(): Promise<AccountViewer | undefined> {
    const revision = this.revision;
    const response = await this.fetchImpl('/auth/browser/session', {
      credentials: 'same-origin', cache: 'no-store',
      headers: this.viewer ? {'X-Finitude-Account-Viewer': this.viewer.userId} : undefined
    });
    if (revision !== this.revision) throw new Error('网页登录状态已改变，请重试。');
    if (response.status === 401) return this.recoverSession(this.viewer?.userId, revision);
    if (response.status === 409) {this.invalidate('viewer-mismatch'); throw new Error('网页登录账户已改变，请重新登录。');}
    if (!response.ok) throw new Error('无法确认网页登录状态，请稍后重试。');
    return this.acceptAccountResponse(response, this.viewer?.userId, revision);
  }

  private async acceptAccountResponse(response: Response, expectedViewer: string | undefined, revision: number, requireEcho = false) {
    const value = object(await response.json()), user = object(value.user);
    if (revision !== this.revision) throw new Error('网页登录状态已改变，请重试。');
    const userId = text(user.id, 128), email = text(user.email, 254);
    if (!/^[a-zA-Z0-9_-]+$/.test(userId) || !['user', 'admin'].includes(String(user.role))) throw new Error('网页登录身份格式不正确。');
    if (requireEcho && response.headers.get('X-Finitude-Account-Viewer')?.trim() !== userId
      || expectedViewer && expectedViewer !== userId || this.viewer && this.viewer.userId !== userId) {
      this.invalidate('viewer-mismatch'); throw new Error('网页登录账户已改变，请重新登录。');
    }
    const changed = this.viewer?.userId !== userId;
    this.viewer = Object.freeze({userId, email, role: user.role as AccountViewer['role']});
    if (changed) this.publishSnapshot();
    return this.viewer;
  }

  /** Only an origin-wide Web Lock may rotate the existing cookie session; every retry stays viewer-bound. */
  private recoverSession(expectedViewer: string | undefined, revision: number): Promise<AccountViewer | undefined> {
    if (this.refreshInFlight?.revision === revision) return this.refreshInFlight.promise;
    if (!this.sessionLocks) return Promise.reject(new Error('浏览器无法安全续期网页登录，请使用 Chrome 并重新登录。'));
    const promise = Promise.resolve(this.sessionLocks.request('finitude:browser-session-transition', {mode: 'exclusive'}, async () => {
      const assertCurrent = () => {if (revision !== this.revision) throw new Error('网页登录账户已改变，请重试。');};
      assertCurrent();
      const headers = expectedViewer ? {'X-Finitude-Account-Viewer': expectedViewer} : undefined;
      const probe = () => this.fetchImpl('/auth/browser/session', {credentials: 'same-origin', cache: 'no-store', headers});
      let response = await probe();
      assertCurrent();
      if (response.ok) return this.acceptAccountResponse(response, expectedViewer, revision);
      if (response.status === 409) {this.invalidate('viewer-mismatch'); throw new Error('网页登录账户存在冲突，请重新登录。');}
      if (response.status !== 401) throw new Error('无法确认网页登录状态，请稍后继续，本机缓存已保留。');
      response = await this.fetchImpl('/auth/browser/refresh', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {...headers, 'Content-Type': 'application/json', 'X-Finitude-Session-Transition': 'web-locks-v1'}, body: '{}'});
      assertCurrent();
      if (response.ok) return this.acceptAccountResponse(response, expectedViewer, revision, true);
      if (response.status === 409) {this.invalidate('viewer-mismatch'); throw new Error('网页登录账户存在冲突，请重新登录。');}
      if (response.status !== 401) throw new Error('网页登录续期暂时不可用，请稍后继续，本机缓存已保留。');
      // Another tab may have won rotation just before this request; prove absence while still holding the lock.
      const winner = await probe();
      assertCurrent();
      if (winner.ok) return this.acceptAccountResponse(winner, expectedViewer, revision);
      if (winner.status === 409) {this.invalidate('viewer-mismatch'); throw new Error('网页登录账户存在冲突，请重新登录。');}
      if (winner.status !== 401) throw new Error('无法确认网页登录状态，请稍后继续，本机缓存已保留。');
      this.invalidate(expectedViewer ? 'logout' : undefined);
      return undefined;
    }));
    const entry = {revision, promise: promise.finally(() => {if (this.refreshInFlight === entry) this.refreshInFlight = undefined;})};
    this.refreshInFlight = entry;
    return entry.promise;
  }

  async analysisRequest() {
    const preparationRevision = this.revision;
    const [status, account] = await Promise.all([this.status(), this.account()]);
    if (preparationRevision !== this.revision || account?.userId !== this.viewer?.userId) {
      throw new Error('网页登录账户已改变，请重新确认后继续分析。');
    }
    if (!status.enabled) throw new Error('服务器暂未开启分析功能，本机数据仍可保存和导出。');
    if (!account) throw new Error('请先通过网页登录 Archtree，再继续分析。');
    const revision = this.revision, sessionSignal = this.transition.signal;
    return {
      concurrency: status.maxConcurrentRequests,
      request: async (input: string | URL | Request, init?: RequestInit) => {
        const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
        if (path !== '/naruto/api/v1/classify' || init?.method !== 'POST' || revision !== this.revision) {
          throw new Error('分析请求已取消或请求地址不正确。');
        }
        const headers = new Headers(init.headers);
        if (headers.has('authorization')) throw new Error('网页版禁止使用桌面账户凭据。');
        headers.set('X-Finitude-Account-Viewer', account.userId);
        const requestInit: RequestInit = {...init, headers, credentials: 'same-origin', cache: 'no-store',
          signal: init.signal ? AbortSignal.any([init.signal, sessionSignal]) : sessionSignal};
        let response = await this.fetchImpl(path, requestInit);
        if (revision !== this.revision) throw new Error('网页登录账户已改变，本次分析响应未使用。');
        if (response.status === 401) {
          const recovered = await this.recoverSession(account.userId, revision);
          if (!recovered || revision !== this.revision) throw new Error('网页登录已结束，请重新登录后继续分析。');
          response = await this.fetchImpl(path, requestInit);
        }
        const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > 2 * 1024 * 1024) {await reader.cancel(); throw new Error('分析服务响应超过安全限制。');}
              chunks.push(chunk.value);
            }
          } finally {reader.releaseLock();}
        }
        if (revision !== this.revision) throw new Error('网页登录账户已改变，本次分析响应未使用。');
        if (response.ok && response.headers.get('X-Finitude-Account-Viewer')?.trim() !== account.userId) {
          this.invalidate('viewer-mismatch'); throw new Error('分析响应无法证明当前账户身份，请重新登录。');
        }
        if (response.status === 409) this.invalidate('viewer-mismatch');
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.length;}
        return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
      }
    };
  }
}
