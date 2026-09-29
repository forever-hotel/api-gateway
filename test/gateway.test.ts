import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { requestPath } from '../src/http.ts';

const secret = 'test-only-gateway-secret-at-least-32-characters';
const sub = randomUUID();
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.closeAllConnections();
        instance.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function token(
  role = 'MANAGER',
  options: {
    expiry?: number;
    secret?: string;
    algorithm?: string;
    roomNumber?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role,
    ...(options.roomNumber ? { roomNumber: options.roomNumber } : {}),
  })
    .setProtectedHeader({ alg: options.algorithm ?? 'HS256' })
    .setSubject(sub)
    .setIssuer('central-auth')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiry ?? 28800))
    .sign(new TextEncoder().encode(options.secret ?? secret));
}
async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const state: Record<string, unknown> = {
    active: true,
    sub,
    role: 'MANAGER',
    passwordChangeRequired: false,
  };
  let outage = false;
  const calls: {
    path?: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[] = [];
  const auth = await server(t, (_req, res) => {
    res.writeHead(outage ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
  });
  const upstream = await server(t, (req, res) => {
    if (req.url === '/health/ready') {
      res.end('{}');
      return;
    }
    if (req.url?.endsWith('/slow')) return;
    if (req.url?.endsWith('/error')) {
      res.writeHead(500);
      res.end('private SQL and password');
      return;
    }
    if (req.url?.endsWith('/redirect')) {
      res.writeHead(302, { location: 'http://private.example' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      calls.push({ path: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'unsafe=1');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      JWT_SECRET: secret,
      JWT_ISSUER: 'central-auth',
      AUTH_SERVICE_URL: auth,
      MAD_SERVICE_URL: upstream,
      AUTH_API_URL: upstream,
      ALLOWED_ORIGINS: 'http://localhost:3000',
    },
    [
      {
        id: 'mad',
        enabled: true,
        prefix: '/mad',
        rewritePrefix: '/mad',
        upstreamEnv: 'MAD_SERVICE_URL',
        roles: ['MANAGER'],
        readOnlyRoles: [],
        endpoints: [],
      },
      {
        id: 'auth',
        enabled: true,
        prefix: '/auth',
        rewritePrefix: '/auth',
        upstreamEnv: 'AUTH_API_URL',
        roles: ['MANAGER'],
        readOnlyRoles: [],
        endpoints: [
          { path: '/login', method: 'POST', access: 'public' },
          { path: '/session', method: 'GET', access: 'password-change' },
          { path: '/logout', method: 'POST', access: 'logout' },
        ],
      },
    ],
  );
  Object.assign(config, overrides);
  const app = await buildApp(config, false);
  t.after(() => app.close());
  const bearer = 'Bearer ' + (await token());
  return {
    app,
    bearer,
    calls,
    state,
    config,
    outage: () => {
      outage = true;
    },
  };
}

test('public login preserves bytes but strips spoofed context, forwarding headers and cookies', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'forged',
      'x-forwarded-for': '203.0.113.1',
      cookie: 'secret=1',
    },
    payload: '{ "username": "manager", "password": "fixture" }',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    calls[0].body,
    '{ "username": "manager", "password": "fixture" }',
  );
  assert.equal(calls[0].headers['x-user-id'], undefined);
  assert.equal(calls[0].headers.cookie, undefined);
  assert.notEqual(calls[0].headers['x-forwarded-for'], '203.0.113.1');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('protected query forwards verified context and preserves the MAD prefix', async (t) => {
  const { app, bearer, calls } = await fixture(t);
  const response = await app.inject({
    url: '/mad/analytics/bookings?period=week',
    headers: { authorization: bearer, 'x-user-role': 'WORKER' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].path, '/mad/analytics/bookings?period=week');
  assert.equal(calls[0].headers['x-user-id'], sub);
  assert.equal(calls[0].headers['x-user-role'], 'MANAGER');
  assert.equal(calls[0].headers.authorization, bearer);
});
test('missing, malformed, wrong signature, expired and non-eight-hour staff tokens fail', async (t) => {
  const { app, calls } = await fixture(t);
  for (const authorization of [
    '',
    'Bearer bad',
    'Bearer ' +
      (await token('MANAGER', {
        secret: 'wrong-secret-at-least-32-characters',
      })),
    'Bearer ' + (await token('MANAGER', { expiry: -1 })),
    'Bearer ' + (await token('MANAGER', { expiry: 3600 })),
    'Bearer ' + (await token('MANAGER', { algorithm: 'HS384' })),
  ]) {
    assert.equal(
      (
        await app.inject({
          url: '/mad/analytics/bookings',
          headers: { authorization },
        })
      ).statusCode,
      401,
    );
  }
  assert.equal(calls.length, 0);
});
test('wrong role, deactivation and password-change gating deny access', async (t) => {
  const { app, bearer, state, calls } = await fixture(t);
  assert.equal(
    (
      await app.inject({
        url: '/mad/analytics/bookings',
        headers: { authorization: 'Bearer ' + (await token('WORKER')) },
      })
    ).statusCode,
    403,
  );
  state.active = false;
  assert.equal(
    (
      await app.inject({
        url: '/mad/analytics/bookings',
        headers: { authorization: bearer },
      })
    ).statusCode,
    401,
  );
  state.active = true;
  state.passwordChangeRequired = true;
  assert.equal(
    (
      await app.inject({
        url: '/mad/analytics/bookings',
        headers: { authorization: bearer },
      })
    ).json().code,
    'PASSWORD_CHANGE_REQUIRED',
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await app.inject({
        url: '/auth/session',
        headers: { authorization: bearer },
      })
    ).statusCode,
    200,
  );
});
test('Auth outage fails closed while valid logout still reaches the MAD revocation handler', async (t) => {
  const { app, bearer, outage } = await fixture(t);
  outage();
  assert.equal(
    (
      await app.inject({
        url: '/mad/analytics/bookings',
        headers: { authorization: bearer },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: bearer },
      })
    ).statusCode,
    200,
  );
});
test('bounded timeout, safe upstream errors and redirects', async (t) => {
  const { app, bearer } = await fixture(t, { upstreamTimeout: 100 });
  for (const [path, status] of [
    ['slow', 504],
    ['error', 503],
    ['redirect', 502],
  ] as const) {
    const response = await app.inject({
      url: '/mad/' + path,
      headers: { authorization: bearer },
    });
    assert.equal(response.statusCode, status);
    assert.ok(!response.body.includes('private'));
  }
});
test('unknown/disabled routes, path traversal and non-allowlisted Auth methods do not proxy', async (t) => {
  const { app, calls } = await fixture(t);
  for (const url of ['/fds/rooms', '/madness', '/auth/internal', '/auth/login'])
    assert.equal((await app.inject({ url })).statusCode, 404);
  for (const url of ['/mad/%2e%2e/auth', '/mad//rooms'])
    assert.equal((await app.inject({ url })).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.throws(() => requestPath('/mad/../auth'));
  assert.throws(() => requestPath('/mad\\auth'));
});
test('request limits, login rate limits and origin restrictions', async (t) => {
  const { app } = await fixture(t, { bodyLimit: 16, loginMax: 2 });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: 'https://untrusted.example' },
        payload: '{}',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: 'x'.repeat(17),
      })
    ).statusCode,
    413,
  );
  await app.inject({ method: 'POST', url: '/auth/login', payload: '{}' });
  const limited = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: '{}',
  });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
});
test('guest requests require a matching active room stay and unexpired checkout', async (t) => {
  const { app, config, state } = await fixture(t);
  config.routes[0].roles = ['GUEST'];
  Object.assign(state, {
    role: 'GUEST',
    roomNumber: '201',
    activeStay: true,
    checkoutAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const authorization =
    'Bearer ' + (await token('GUEST', { expiry: 86400, roomNumber: '201' }));
  assert.equal(
    (await app.inject({ url: '/mad/rooms', headers: { authorization } }))
      .statusCode,
    200,
  );
  state.activeStay = false;
  assert.equal(
    (await app.inject({ url: '/mad/rooms', headers: { authorization } }))
      .statusCode,
    401,
  );
});
test('read-only role policy permits reads but denies writes', async (t) => {
  const { app, config, bearer } = await fixture(t);
  config.routes[0].roles = ['RECEPTIONIST'];
  config.routes[0].readOnlyRoles = ['MANAGER'];
  assert.equal(
    (
      await app.inject({
        url: '/mad/rooms',
        headers: { authorization: bearer },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/mad/rooms',
        headers: { authorization: bearer },
      })
    ).statusCode,
    403,
  );
});
test('health distinguishes liveness from upstream readiness', async (t) => {
  const { app, config } = await fixture(t);
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
  config.routes[0].upstream = 'http://127.0.0.1:1';
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 503);
  assert.equal((await app.inject({ url: '/health/live' })).statusCode, 200);
});
test('invalid authentication also consumes the rate limit before reaching Auth', async (t) => {
  const { app } = await fixture(t, { rateMax: 1 });
  assert.equal((await app.inject({ url: '/mad/rooms' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/mad/rooms' })).statusCode, 429);
});

test('configuration rejects secrets/origins/routes that cannot enforce the contract', () => {
  const env = {
    JWT_SECRET: secret,
    JWT_ISSUER: 'central-auth',
    AUTH_SERVICE_URL: 'http://localhost:5000',
    MAD_SERVICE_URL: 'http://localhost:4000',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  };
  const routes = [
    {
      id: 'mad',
      enabled: true,
      prefix: '/mad',
      rewritePrefix: '/mad',
      upstreamEnv: 'MAD_SERVICE_URL',
      roles: ['MANAGER'],
      readOnlyRoles: [],
      endpoints: [],
    },
  ];
  assert.throws(() => loadConfig({ ...env, JWT_SECRET: 'short' }, routes));
  assert.throws(() =>
    loadConfig({ ...env, TRUSTED_PROXIES: '0.0.0.0/0' }, routes),
  );
  assert.throws(() =>
    loadConfig(
      { ...env, MAD_SERVICE_URL: 'http://user:secret@localhost:4000' },
      routes,
    ),
  );
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }, routes));
  assert.throws(() =>
    loadConfig(env, [...routes, { ...routes[0], id: 'other' }]),
  );
});
