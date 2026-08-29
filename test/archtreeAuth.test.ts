import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ArchtreeAuthService,
  StoredArchtreeSession
} from '../src/services/archtreeAuth';

const userId = '64b000000000000000000001';
const future = () => new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const token = (label: string) => `${label}-${'x'.repeat(48)}`;

test('logs in, persists only the encrypted-storage projection, and logs out', async () => {
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const requests: Array<{path: string; authorization: string | null; body: string}> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: String(init?.body ?? '')
    });
    if (url.pathname === '/auth/login') {
      return new Response(JSON.stringify({
        accessToken: token('access-one'),
        refreshToken: token('refresh-one'),
        accessTokenExpiresIn: 900,
        refreshTokenExpiresAt: future(),
        userId,
        email: 'friend@example.com',
        role: 'user'
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (url.pathname.endsWith('/access')) return new Response(JSON.stringify({authorized: true}), {status: 200});
    if (url.pathname.endsWith('/classify')) return new Response('{}', {status: 200});
    if (url.pathname === '/auth/logout') return new Response(null, {status: 204});
    return new Response('{}', {status: 404});
  }) as typeof fetch;
  const service = new ArchtreeAuthService({
    fetchImpl,
    persistSession: async (session) => { persisted.push(session); }
  });

  const account = await service.login('friend@example.com', 'private-password');
  assert.deepEqual(account, {userId, email: 'friend@example.com', role: 'user'});
  assert.equal(service.signedIn, true);
  assert.equal('accessToken' in persisted[0]!, false);
  assert.doesNotMatch(JSON.stringify(persisted), /private-password|access-one/);
  assert.match(persisted[0]!.refreshToken, /^refresh-one/);

  await service.request('https://kashewt.com/naruto-mobile/api/v1/classify', {method: 'POST'});
  assert.equal(requests.at(-1)?.authorization, `Bearer ${token('access-one')}`);
  await service.logout();
  assert.equal(service.signedIn, false);
  assert.equal(persisted.at(-1), undefined);
  assert.match(requests.at(-1)?.body ?? '', /refresh-one/);
});

test('rejects a second login without replacing the active refresh session', async () => {
  let loginCount = 0;
  const persisted: StoredArchtreeSession[] = [];
  const service = new ArchtreeAuthService({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/auth/login') {
        loginCount += 1;
        return new Response(JSON.stringify({
          accessToken: token('access-original'),
          refreshToken: token('refresh-original'),
          accessTokenExpiresIn: 900,
          refreshTokenExpiresAt: future(),
          userId,
          email: 'friend@example.com',
          role: 'user'
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      return new Response('{}', {status: 404});
    }) as typeof fetch,
    persistSession: async (session) => {
      if (session) persisted.push(session);
    }
  });

  await service.login('friend@example.com', 'private-password');
  await assert.rejects(
    service.login('other@example.com', 'other-password'),
    (error: unknown) => error instanceof Error
      && 'statusCode' in error
      && error.statusCode === 409
  );

  assert.equal(loginCount, 1);
  assert.equal(persisted.length, 1);
  assert.match(persisted[0].refreshToken, /^refresh-original/);
});

test('serializes refresh rotation and persists the replacement before retrying concurrent 401s', async () => {
  let refreshCount = 0;
  let forceUnauthorized = false;
  const events: string[] = [];
  const initial: StoredArchtreeSession = {
    version: 1,
    userId,
    email: 'friend@example.com',
    role: 'user',
    refreshToken: token('refresh-zero'),
    refreshTokenExpiresAt: future()
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === '/auth/refresh') {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        accessToken: token(`access-${refreshCount}`),
        refreshToken: token(`refresh-${refreshCount}`),
        accessTokenExpiresIn: 900,
        refreshTokenExpiresAt: future()
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (url.pathname.endsWith('/classify')) {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      events.push(`request:${authorization.includes('access-2') ? '2' : '1'}`);
      if (forceUnauthorized && authorization.includes('access-1')) {
        return new Response('{}', {status: 401});
      }
      return new Response('{}', {status: 200});
    }
    return new Response('{}', {status: 404});
  }) as typeof fetch;
  const service = new ArchtreeAuthService({
    initialSession: initial,
    fetchImpl,
    persistSession: async (session) => {
      events.push(`persist:${session?.refreshToken.includes('refresh-2') ? '2' : '1'}`);
    }
  });

  await service.request('https://kashewt.com/naruto-mobile/api/v1/classify');
  assert.equal(refreshCount, 1);
  forceUnauthorized = true;
  events.length = 0;
  const responses = await Promise.all([
    service.request('https://kashewt.com/naruto-mobile/api/v1/classify'),
    service.request('https://kashewt.com/naruto-mobile/api/v1/classify')
  ]);
  assert.deepEqual(responses.map(({status}) => status), [200, 200]);
  assert.equal(refreshCount, 2);
  assert.ok(events.indexOf('persist:2') < events.lastIndexOf('request:2'));
});

test('clears a locally stored session when refresh is rejected', async () => {
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const service = new ArchtreeAuthService({
    initialSession: {
      version: 1,
      userId,
      email: 'friend@example.com',
      role: 'user',
      refreshToken: token('expired-remotely'),
      refreshTokenExpiresAt: future()
    },
    fetchImpl: (async () => new Response(JSON.stringify({message: 'Authentication failed.'}), {
      status: 401,
      headers: {'content-type': 'application/json'}
    })) as typeof fetch,
    persistSession: async (session) => { persisted.push(session); }
  });

  await assert.rejects(
    service.request('https://kashewt.com/naruto-mobile/api/v1/classify'),
    /登录已失效/
  );
  assert.equal(service.signedIn, false);
  assert.equal(persisted.at(-1), undefined);
});

test('logout waits for an in-flight refresh and revokes the rotated session', async () => {
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  let revokedToken = '';
  const service = new ArchtreeAuthService({
    initialSession: {
      version: 1,
      userId,
      email: 'friend@example.com',
      role: 'user',
      refreshToken: token('refresh-old'),
      refreshTokenExpiresAt: future()
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/auth/refresh') {
        refreshStarted();
        await release;
        return new Response(JSON.stringify({
          accessToken: token('access-new'),
          refreshToken: token('refresh-new'),
          accessTokenExpiresIn: 900,
          refreshTokenExpiresAt: future()
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (url.pathname === '/auth/logout') {
        revokedToken = String(JSON.parse(String(init?.body)).refreshToken);
        return new Response(null, {status: 204});
      }
      if (url.pathname.endsWith('/classify')) return new Response('{}', {status: 200});
      return new Response('{}', {status: 404});
    }) as typeof fetch,
    persistSession: async (session) => { persisted.push(session); }
  });

  const request = service.request('https://kashewt.com/naruto-mobile/api/v1/classify');
  await started;
  const logout = service.logout();
  releaseRefresh();
  assert.equal((await request).status, 200);
  await logout;

  assert.match(revokedToken, /^refresh-new/);
  assert.equal(service.signedIn, false);
  assert.equal(persisted.at(-1), undefined);
});

test('does not approve paid work after a concurrent logout clears the session', async () => {
  let accessStarted!: () => void;
  let releaseAccess!: () => void;
  const started = new Promise<void>((resolve) => { accessStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseAccess = resolve; });
  const service = new ArchtreeAuthService({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/auth/login') {
        return new Response(JSON.stringify({
          accessToken: token('access-current'),
          refreshToken: token('refresh-current'),
          accessTokenExpiresIn: 900,
          refreshTokenExpiresAt: future(),
          userId,
          email: 'friend@example.com',
          role: 'user'
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (url.pathname.endsWith('/access')) {
        accessStarted();
        await release;
        return new Response(JSON.stringify({authorized: true}), {status: 200});
      }
      if (url.pathname === '/auth/logout') return new Response(null, {status: 204});
      return new Response('{}', {status: 404});
    }) as typeof fetch,
    persistSession: async () => undefined
  });

  await service.login('friend@example.com', 'private-password');
  const access = service.ensureAccess();
  await started;
  await service.logout();
  releaseAccess();

  await assert.rejects(access, /\u8bf7\u5148\u767b\u5f55 Archtree/);
});

test('clears the local session even when remote logout is unavailable', async () => {
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const service = new ArchtreeAuthService({
    initialSession: {
      version: 1,
      userId,
      email: 'friend@example.com',
      role: 'user',
      refreshToken: token('refresh-local'),
      refreshTokenExpiresAt: future()
    },
    fetchImpl: (async () => {
      throw new TypeError('network unavailable');
    }) as typeof fetch,
    persistSession: async (session) => { persisted.push(session); }
  });

  await service.logout();

  assert.equal(service.signedIn, false);
  assert.equal(persisted.at(-1), undefined);
});

test('preserves the account when the analysis access check is rate limited', async () => {
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const service = new ArchtreeAuthService({
    initialSession: {
      version: 1,
      userId,
      email: 'friend@example.com',
      role: 'user',
      refreshToken: token('refresh-restored'),
      refreshTokenExpiresAt: future()
    },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/auth/refresh') {
        return new Response(JSON.stringify({
          accessToken: token('access-restored'),
          refreshToken: token('refresh-rotated'),
          accessTokenExpiresIn: 900,
          refreshTokenExpiresAt: future()
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (url.pathname.endsWith('/access')) return new Response('{}', {status: 429});
      return new Response('{}', {status: 404});
    }) as typeof fetch,
    persistSession: async (session) => { persisted.push(session); }
  });

  await assert.rejects(service.ensureAccess(), (error: unknown) => (
    error instanceof Error
    && 'statusCode' in error
    && error.statusCode === 429
  ));
  assert.equal(service.signedIn, true);
  assert.notEqual(persisted.at(-1), undefined);
});

test('preserves the account when the analysis proxy route is not deployed yet', async () => {
  const persisted: Array<StoredArchtreeSession | undefined> = [];
  const service = new ArchtreeAuthService({
    initialSession: {
      version: 1,
      userId,
      email: 'friend@example.com',
      role: 'user',
      refreshToken: token('refresh-restored'),
      refreshTokenExpiresAt: future()
    },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/auth/refresh') {
        return new Response(JSON.stringify({
          accessToken: token('access-restored'),
          refreshToken: token('refresh-rotated'),
          accessTokenExpiresIn: 900,
          refreshTokenExpiresAt: future()
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (url.pathname.endsWith('/access')) return new Response('{}', {status: 404});
      return new Response('{}', {status: 404});
    }) as typeof fetch,
    persistSession: async (session) => { persisted.push(session); }
  });

  await assert.rejects(service.ensureAccess(), (error: unknown) => (
    error instanceof Error
    && 'statusCode' in error
    && error.statusCode === 503
  ));
  assert.equal(service.signedIn, true);
  assert.notEqual(persisted.at(-1), undefined);
});
