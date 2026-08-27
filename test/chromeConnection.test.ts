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
    async () => '43117\n/devtools/browser/68bfe547-a619-4cb8-a50c-234fa7c7ed9b\n'
  );
  assert.equal(
    endpoint?.webSocketUrl,
    'ws://127.0.0.1:43117/devtools/browser/68bfe547-a619-4cb8-a50c-234fa7c7ed9b'
  );
});

test('connects to the daily Chrome context and confirms the Bilibili account', async () => {
  let connectedEndpoint = '';
  let browserConnected = true;
  let disconnectListener: (() => void) | undefined;
  let loginCheckClosed = false;
  const page = {
    goto: async () => ({ok: () => true, status: () => 200}),
    locator: () => ({
      innerText: async () => JSON.stringify({code: 0, data: {isLogin: true, uname: '测试玩家', mid: 12345678}})
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
