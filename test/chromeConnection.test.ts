import assert from 'node:assert/strict';
import test from 'node:test';
import {Browser, BrowserContext, Page} from 'playwright';
import {
  ChromeConnectionService,
  chromeUserDataDirectory,
  discoverChromeEndpoint
} from '../src/services/chromeConnection';

test('resolves the standard Windows Chrome profile without requiring user input', () => {
  assert.equal(
    chromeUserDataDirectory('chrome', 'win32', {LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'}, 'C:\\Users\\tester'),
    'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data'
  );
});

test('discovers and validates a dynamic loopback websocket endpoint', async () => {
  const endpoint = await discoverChromeEndpoint(
    {browserChannel: 'chrome'},
    async () => '43117\n/devtools/browser/68bfe547-a619-4cb8-a50c-234fa7c7ed9b\n',
    async () => true
  );
  assert.equal(
    endpoint?.webSocketUrl,
    'ws://127.0.0.1:43117/devtools/browser/68bfe547-a619-4cb8-a50c-234fa7c7ed9b'
  );
});

test('ignores a stale Chrome endpoint file when its port is no longer listening', async () => {
  const endpoint = await discoverChromeEndpoint(
    {browserChannel: 'chrome'},
    async () => '9222\n/devtools/browser/stale-browser-id\n',
    async () => false
  );
  assert.equal(endpoint, undefined);
});

test('connects to the daily Chrome context and confirms the Bilibili account', async () => {
  let connectedEndpoint = '';
  let browserConnected = true;
  let disconnectListener: (() => void) | undefined;
  let loginCheckClosed = false;
  const page = {
    goto: async () => ({
      ok: () => true,
      status: () => 200,
      text: async () => JSON.stringify({code: 0, data: {isLogin: true, uname: '测试玩家', mid: 12345678}})
    }),
    close: async () => { loginCheckClosed = true; }
  } as unknown as Page;
  const context = {newPage: async () => page} as unknown as BrowserContext;
  const browser = {
    isConnected: () => browserConnected,
    contexts: () => [context],
    once: (_event: string, listener: () => void) => { disconnectListener = listener; },
    close: async () => {
      browserConnected = false;
      disconnectListener?.();
    }
  } as unknown as Browser;
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async (endpoint) => {
      connectedEndpoint = endpoint;
      return browser;
    },
    async () => ({webSocketUrl: 'ws://127.0.0.1:43117/devtools/browser/test-id'})
  );

  const status = await service.connect();
  assert.equal(connectedEndpoint, 'ws://127.0.0.1:43117/devtools/browser/test-id');
  assert.equal(status.connected, true);
  assert.equal(status.loginState, 'logged_in');
  assert.equal(status.accountName, '测试玩家');
  assert.equal(status.accountUidSuffix, '5678');
  assert.equal(loginCheckClosed, true);

  const lease = await service.acquire();
  await assert.rejects(service.disconnect(), /调查正在使用 Chrome/);
  lease.release();
  const disconnected = await service.disconnect();
  assert.equal(disconnected.connected, false);
});

test('reports a beginner-friendly state before remote debugging is enabled', async () => {
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async () => { throw new Error('must not connect'); },
    async () => undefined
  );
  const status = await service.status();
  assert.equal(status.state, 'not_ready');
  assert.equal(status.remoteDebuggingEnabled, false);
  await assert.rejects(service.connect(), /尚未发现 Chrome 连接/);
});

test('does not expose Playwright websocket diagnostics after a connection race', async () => {
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async () => {
      throw new Error('browserType.connectOverCDP: WebSocket error: connect ECONNREFUSED 127.0.0.1:9222');
    },
    async () => ({webSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/stale-browser-id'})
  );

  await assert.rejects(service.connect(), /请保持 Chrome 打开/);
  const status = await service.status();
  assert.equal(status.state, 'error');
  assert.match(status.message, /请保持 Chrome 打开/);
  assert.doesNotMatch(status.message, /ECONNREFUSED|9222|connectOverCDP/);
});

test('finishes disconnecting before a queued reconnect creates a new connection', async () => {
  let firstConnected = true;
  let secondConnected = true;
  let firstDisconnected: (() => void) | undefined;
  let secondDisconnected: (() => void) | undefined;
  let releaseClose: (() => void) | undefined;
  let closeStarted: (() => void) | undefined;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const closeBegan = new Promise<void>((resolve) => { closeStarted = resolve; });
  const accountPage = (name: string) => ({
    goto: async () => ({
      ok: () => true,
      status: () => 200,
      text: async () => JSON.stringify({code: 0, data: {isLogin: true, uname: name, mid: 12345678}})
    }),
    close: async () => undefined
  } as unknown as Page);
  const firstContext = {newPage: async () => accountPage('第一次连接')} as unknown as BrowserContext;
  const secondContext = {newPage: async () => accountPage('第二次连接')} as unknown as BrowserContext;
  const firstBrowser = {
    isConnected: () => firstConnected,
    contexts: () => [firstContext],
    once: (_event: string, listener: () => void) => { firstDisconnected = listener; },
    close: async () => {
      closeStarted?.();
      await closeGate;
      firstConnected = false;
      firstDisconnected?.();
    }
  } as unknown as Browser;
  const secondBrowser = {
    isConnected: () => secondConnected,
    contexts: () => [secondContext],
    once: (_event: string, listener: () => void) => { secondDisconnected = listener; },
    close: async () => {
      secondConnected = false;
      secondDisconnected?.();
    }
  } as unknown as Browser;
  let connectorCalls = 0;
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async () => connectorCalls++ === 0 ? firstBrowser : secondBrowser,
    async () => ({webSocketUrl: 'ws://127.0.0.1:43117/devtools/browser/test-id'})
  );

  assert.equal((await service.connect()).accountName, '第一次连接');
  const disconnecting = service.disconnect();
  await closeBegan;
  assert.equal((await service.status()).state, 'disconnecting');
  const reconnecting = service.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectorCalls, 1);
  releaseClose?.();
  await disconnecting;
  const reconnected = await reconnecting;
  assert.equal(connectorCalls, 2);
  assert.equal(reconnected.loginState, 'logged_in');
  assert.equal(reconnected.accountName, '第二次连接');
});

test('keeps the connection visible when disconnecting fails', async () => {
  const page = {
    goto: async () => ({
      ok: () => true,
      status: () => 200,
      text: async () => JSON.stringify({code: 0, data: {isLogin: true, uname: '测试玩家'}})
    }),
    close: async () => undefined
  } as unknown as Page;
  const context = {newPage: async () => page} as unknown as BrowserContext;
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    once: () => undefined,
    close: async () => { throw new Error('close failed'); }
  } as unknown as Browser;
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async () => browser,
    async () => ({webSocketUrl: 'ws://127.0.0.1:43117/devtools/browser/test-id'})
  );

  await service.connect();
  await assert.rejects(service.disconnect(), /尚未断开/);
  const status = await service.status();
  assert.equal(status.connected, true);
  assert.equal(status.state, 'connected');
});

test('recovers when a connected Chrome succeeds on the second Bilibili login check', async () => {
  let loginAttempts = 0;
  const page = {
    goto: async () => {
      loginAttempts += 1;
      if (loginAttempts === 1) throw new Error('temporary navigation failure');
      return {
        ok: () => true,
        status: () => 200,
        text: async () => JSON.stringify({code: 0, data: {isLogin: true, uname: '恢复玩家'}})
      };
    },
    close: async () => undefined
  } as unknown as Page;
  const context = {newPage: async () => page} as unknown as BrowserContext;
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    once: () => undefined,
    close: async () => undefined
  } as unknown as Browser;
  let connectorCalls = 0;
  const service = new ChromeConnectionService(
    {browserChannel: 'chrome'},
    async () => { connectorCalls += 1; return browser; },
    async () => ({webSocketUrl: 'ws://127.0.0.1:43117/devtools/browser/test-id'})
  );

  await assert.rejects(service.connect(), /暂时无法检查 B站登录/);
  const failedCheck = await service.status();
  assert.equal(failedCheck.connected, true);
  assert.equal(failedCheck.loginState, 'unknown');
  assert.match(failedCheck.message, /重新检查 B站登录/);

  const recovered = await service.connect();
  assert.equal(connectorCalls, 1);
  assert.equal(recovered.loginState, 'logged_in');
  assert.equal(recovered.accountName, '恢复玩家');
  assert.doesNotMatch(recovered.message, /暂时无法检查/);
});
