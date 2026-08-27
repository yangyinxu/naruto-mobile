import {readFile} from 'node:fs/promises';
import {Socket} from 'node:net';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {Browser, BrowserContext, chromium, Page} from 'playwright';
import {AppConfig} from '../config';

export type BilibiliLoginState = 'unknown' | 'logged_in' | 'logged_out';
export type ChromeConnectionState = 'not_ready' | 'ready' | 'connecting' | 'disconnecting' | 'connected' | 'error';

export interface ChromeConnectionStatus {
  state: ChromeConnectionState;
  remoteDebuggingEnabled: boolean;
  connected: boolean;
  loginState: BilibiliLoginState;
  accountName?: string;
  accountUidSuffix?: string;
  activeInvestigations: number;
  message: string;
}

interface ChromeEndpoint {
  webSocketUrl: string;
}

interface BilibiliAccount {
  loginState: BilibiliLoginState;
  accountName?: string;
  accountUidSuffix?: string;
}

type ChromeConnector = (endpoint: string, options: {timeout: number}) => Promise<Browser>;
type TextReader = (path: string, encoding: BufferEncoding) => Promise<string>;
type EndpointProbe = (endpoint: ChromeEndpoint) => Promise<boolean>;

export class ChromeConnectionError extends Error {
  readonly statusCode = 409;
}

const chromeDirectoryNames: Record<string, {windows: string; mac: string; linux: string}> = {
  chrome: {
    windows: join('Google', 'Chrome', 'User Data'),
    mac: join('Google', 'Chrome'),
    linux: 'google-chrome'
  },
  'chrome-beta': {
    windows: join('Google', 'Chrome Beta', 'User Data'),
    mac: join('Google', 'Chrome Beta'),
    linux: 'google-chrome-beta'
  },
  'chrome-canary': {
    windows: join('Google', 'Chrome SxS', 'User Data'),
    mac: join('Google', 'Chrome Canary'),
    linux: 'google-chrome-canary'
  }
};

/** Resolves Chrome's local profile root without exposing it in the web API. */
export const chromeUserDataDirectory = (
  channel: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir()
) => {
  const configured = environment.CHROME_USER_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  const names = chromeDirectoryNames[channel] ?? chromeDirectoryNames.chrome;
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, names.windows) : undefined;
  }
  if (platform === 'darwin') return join(userHome, 'Library', 'Application Support', names.mac);
  const configRoot = environment.XDG_CONFIG_HOME?.trim() || join(userHome, '.config');
  return join(configRoot, names.linux);
};

const validatedEndpoint = (contents: string): ChromeEndpoint => {
  const [rawPort, rawPath] = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ChromeConnectionError('Chrome 连接信息中的端口无效。请关闭并重新打开远程调试开关。');
  }
  if (!rawPath?.startsWith('/devtools/browser/')) {
    throw new ChromeConnectionError('Chrome 连接信息不完整。请关闭并重新打开远程调试开关。');
  }
  const webSocketUrl = new URL(`ws://127.0.0.1:${port}${rawPath}`);
  if (webSocketUrl.protocol !== 'ws:' || webSocketUrl.hostname !== '127.0.0.1') {
    throw new ChromeConnectionError('为了安全，只允许连接当前电脑上的 Chrome。');
  }
  return {webSocketUrl: webSocketUrl.toString()};
};

/** Rejects stale DevToolsActivePort files left behind after Chrome exits. */
export const chromeEndpointIsListening = (
  endpoint: ChromeEndpoint,
  timeoutMs = 750
) => new Promise<boolean>((resolveProbe) => {
  const url = new URL(endpoint.webSocketUrl);
  const socket = new Socket();
  let settled = false;
  const finish = (listening: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolveProbe(listening);
  };
  socket.setTimeout(timeoutMs);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
  socket.connect(Number(url.port), url.hostname);
});

export const discoverChromeEndpoint = async (
  config: Pick<AppConfig, 'browserChannel'>,
  reader: TextReader = readFile,
  probe: EndpointProbe = chromeEndpointIsListening
) => {
  const userDataDirectory = chromeUserDataDirectory(config.browserChannel);
  if (!userDataDirectory) return undefined;
  try {
    const endpoint = validatedEndpoint(await reader(join(userDataDirectory, 'DevToolsActivePort'), 'utf8'));
    return await probe(endpoint) ? endpoint : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const accountFromPage = async (page: Page): Promise<BilibiliAccount> => {
  const response = await page.goto('https://api.bilibili.com/x/web-interface/nav', {
    waitUntil: 'domcontentloaded',
    timeout: 15_000
  });
  if (!response?.ok()) throw new Error(`B站登录检查返回 ${response?.status() ?? '未知状态'}。`);
  const text = (await response.text()).replace(/^\uFEFF/, '');
  const value = JSON.parse(text) as {
    code?: number;
    data?: {isLogin?: boolean; uname?: string; mid?: number | string};
  };
  if (value.code !== 0 || !value.data?.isLogin) return {loginState: 'logged_out'};
  const uid = String(value.data.mid ?? '');
  return {
    loginState: 'logged_in',
    accountName: value.data.uname?.trim() || '已登录用户',
    accountUidSuffix: uid ? uid.slice(-4) : undefined
  };
};

/** Owns one permissioned connection to the user's daily Chrome session. */
export class ChromeConnectionService {
  private browser?: Browser;
  private context?: BrowserContext;
  private connecting?: Promise<ChromeConnectionStatus>;
  private disconnecting?: Promise<void>;
  private account: BilibiliAccount = {loginState: 'unknown'};
  private lastError = '';
  private activeInvestigations = 0;

  constructor(
    private readonly config: Pick<AppConfig, 'browserChannel'>,
    private readonly connector: ChromeConnector = (endpoint, options) => chromium.connectOverCDP(endpoint, options),
    private readonly endpointDiscovery: () => Promise<ChromeEndpoint | undefined> = () => discoverChromeEndpoint(config)
  ) {}

  private connected() {
    return Boolean(this.browser?.isConnected() && this.context);
  }

  private connectedStatus(): ChromeConnectionStatus {
    const loggedIn = this.account.loginState === 'logged_in';
    return {
      state: 'connected',
      remoteDebuggingEnabled: true,
      connected: true,
      loginState: this.account.loginState,
      accountName: this.account.accountName,
      accountUidSuffix: this.account.accountUidSuffix,
      activeInvestigations: this.activeInvestigations,
      message: loggedIn
        ? `Chrome 已连接，B站账号 ${this.account.accountName ?? ''} 可以开始调查。`
        : this.account.loginState === 'logged_out'
          ? 'Chrome 已连接，但尚未检测到已登录的 B站账号。'
          : this.lastError || 'Chrome 已连接，但暂时无法确认 B站登录状态。'
    };
  }

  async status(): Promise<ChromeConnectionStatus> {
    if (this.disconnecting) {
      return {
        state: 'disconnecting',
        remoteDebuggingEnabled: true,
        connected: this.connected(),
        loginState: this.account.loginState,
        accountName: this.account.accountName,
        accountUidSuffix: this.account.accountUidSuffix,
        activeInvestigations: this.activeInvestigations,
        message: '正在安全断开 Chrome，请稍候。'
      };
    }
    if (this.connecting) {
      return {
        state: 'connecting',
        remoteDebuggingEnabled: true,
        connected: false,
        loginState: 'unknown',
        activeInvestigations: this.activeInvestigations,
        message: '正在请求连接，请在 Chrome 弹窗中点击“允许”。'
      };
    }
    if (this.connected()) return this.connectedStatus();
    try {
      const endpoint = await this.endpointDiscovery();
      return endpoint ? {
        state: this.lastError ? 'error' : 'ready',
        remoteDebuggingEnabled: true,
        connected: false,
        loginState: 'unknown',
        activeInvestigations: this.activeInvestigations,
        message: this.lastError || 'Chrome 已准备好，点击连接后请在 Chrome 中允许访问。'
      } : {
        state: 'not_ready',
        remoteDebuggingEnabled: false,
        connected: false,
        loginState: 'unknown',
        activeInvestigations: this.activeInvestigations,
        message: '请保持 Chrome 打开，并在 Chrome 中开启远程调试。'
      };
    } catch (error) {
      return {
        state: 'error',
        remoteDebuggingEnabled: false,
        connected: false,
        loginState: 'unknown',
        activeInvestigations: this.activeInvestigations,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async inspectAccount() {
    if (!this.context) throw new ChromeConnectionError('Chrome 连接已经断开，请重新连接。');
    let page: Page | undefined;
    try {
      page = await this.context.newPage();
      this.account = await accountFromPage(page);
      this.lastError = '';
    } catch (error) {
      this.account = {loginState: 'unknown'};
      this.lastError = error instanceof Error && error.message.startsWith('B站登录检查返回')
        ? `${error.message} 请确认 B站可以正常打开，然后重新检查。`
        : 'Chrome 已连接，但暂时无法检查 B站登录。请确认网络正常，然后点击“重新检查 B站登录”。';
      throw new ChromeConnectionError(this.lastError);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async connect(): Promise<ChromeConnectionStatus> {
    if (this.disconnecting) await this.disconnecting;
    if (this.connecting) return this.connecting;
    if (this.connected()) {
      await this.inspectAccount();
      return this.connectedStatus();
    }
    this.connecting = this.connectOnce();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connectOnce(): Promise<ChromeConnectionStatus> {
    const endpoint = await this.endpointDiscovery();
    if (!endpoint) {
      throw new ChromeConnectionError('尚未发现 Chrome 连接。请先打开远程调试开关，然后重试。');
    }
    this.lastError = '';
    let browser: Browser;
    try {
      browser = await this.connector(endpoint.webSocketUrl, {timeout: 30_000});
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        throw new ChromeConnectionError('Chrome 没有提供可用的日常浏览上下文。请使用普通窗口而不是无痕窗口。');
      }
      this.browser = browser;
      this.context = context;
      browser.once('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = undefined;
        this.context = undefined;
        this.account = {loginState: 'unknown'};
        this.lastError = '';
        this.activeInvestigations = 0;
      });
    } catch (error) {
      this.browser = undefined;
      this.context = undefined;
      this.account = {loginState: 'unknown'};
      if (error instanceof ChromeConnectionError) {
        this.lastError = error.message;
        throw error;
      }
      const friendlyMessage = '无法连接 Chrome。请保持 Chrome 打开、确认远程调试已开启，并在 Chrome 弹窗中点击“允许”。';
      this.lastError = friendlyMessage;
      throw new ChromeConnectionError(friendlyMessage);
    }
    await this.inspectAccount();
    return this.connectedStatus();
  }

  async acquire(): Promise<{context: BrowserContext; release: () => void}> {
    if (!this.connected() || !this.context) {
      throw new ChromeConnectionError('真实调查前请先连接已经登录 B站的 Chrome。');
    }
    if (this.account.loginState !== 'logged_in') {
      throw new ChromeConnectionError('当前 Chrome 尚未登录 B站。请登录后点击“重新检查”。');
    }
    this.activeInvestigations += 1;
    let released = false;
    return {
      context: this.context,
      release: () => {
        if (released) return;
        released = true;
        this.activeInvestigations = Math.max(0, this.activeInvestigations - 1);
      }
    };
  }

  private async disconnectOnce() {
    if (this.activeInvestigations > 0) {
      throw new ChromeConnectionError('调查正在使用 Chrome，请先暂停或等待调查完成。');
    }
    const browser = this.browser;
    if (browser) {
      try {
        await browser.close({reason: '用户主动断开调查工具'});
      } catch {
        if (browser.isConnected()) {
          throw new ChromeConnectionError('Chrome 连接尚未断开，请稍候再试。');
        }
      }
    }
    if (this.browser === browser) {
      this.browser = undefined;
      this.context = undefined;
      this.account = {loginState: 'unknown'};
      this.activeInvestigations = 0;
    }
    this.lastError = '';
  }

  async disconnect() {
    if (this.activeInvestigations > 0) {
      throw new ChromeConnectionError('调查正在使用 Chrome，请先暂停或等待调查完成。');
    }
    if (this.connecting) await this.connecting.catch(() => undefined);
    if (!this.disconnecting) {
      this.disconnecting = this.disconnectOnce();
      try {
        await this.disconnecting;
      } finally {
        this.disconnecting = undefined;
      }
    } else {
      await this.disconnecting;
    }
    return this.status();
  }
}
