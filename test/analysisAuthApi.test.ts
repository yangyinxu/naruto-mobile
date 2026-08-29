import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../src/api/app';
import {AppConfig} from '../src/config';
import {FileRunStore} from '../src/infrastructure/fileRunStore';
import {ArchtreeAuthService, StoredArchtreeSession} from '../src/services/archtreeAuth';
import {RunManager} from '../src/services/runManager';

const token = (label: string) => `${label}-${'x'.repeat(48)}`;

test('exposes only the signed-in Archtree account through the local API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-auth-api-'));
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === '/auth/login') {
      return new Response(JSON.stringify({
        accessToken: token('access'),
        refreshToken: token('refresh'),
        accessTokenExpiresIn: 900,
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        userId: '64b000000000000000000009',
        email: 'any-user@example.com',
        role: 'user'
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (url.pathname.endsWith('/access')) {
      return new Response(JSON.stringify({authorized: true, protocolVersion: 1}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    }
    if (url.pathname === '/auth/logout') return new Response(null, {status: 204});
    return new Response('{}', {status: 404});
  }) as typeof fetch;
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    dataRoot: directory,
    browserChannel: 'chrome',
    browserHeadless: true,
    openBrowser: false,
    uidSalt: 'test-salt',
    analysisTransport: 'proxy',
    proxyBaseUrl: 'http://127.0.0.1:9999/naruto-mobile/api/v1',
    aiModel: 'gpt-5.6-luna',
    aiReasoningEffort: 'medium',
    aiBatchSize: 10,
    aiConcurrency: 3
  };
  const analysisAuth = new ArchtreeAuthService({
    proxyBaseUrl: config.proxyBaseUrl,
    fetchImpl,
    persistSession: async (session) => { persisted.push(session); }
  });
  const manager = new RunManager(new FileRunStore(directory), config, analysisAuth);
  await manager.initialize();
  const server = createApp(manager, config, {webRoot: join(directory, 'missing-web')})
    .listen(0, config.host);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://${config.host}:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/analysis/login`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({identifier: 'any-user@example.com', password: 'private-password'})
    });
    assert.equal(login.status, 200);
    const loginText = await login.text();
    assert.deepEqual(JSON.parse(loginText), {
      signedIn: true,
      account: {
        userId: '64b000000000000000000009',
        email: 'any-user@example.com',
        role: 'user'
      }
    });
    assert.doesNotMatch(loginText, /private-password|access-|refresh-/);

    const settingsText = await (await fetch(`${baseUrl}/api/settings`)).text();
    assert.doesNotMatch(settingsText, /private-password|access-|refresh-/);
    assert.equal(JSON.parse(settingsText).analysis.aiConfigured, true);
    assert.equal('accessToken' in persisted[0]!, false);

    const logout = await fetch(`${baseUrl}/api/analysis/logout`, {method: 'POST'});
    assert.equal(logout.status, 204);
    assert.equal(persisted.at(-1), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
