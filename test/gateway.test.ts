import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { requestPath } from '../src/http.ts';

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

const routes = [
  {
    id: 'mad',
    enabled: true,
    prefix: '/mad',
    rewritePrefix: '/mad',
    upstreamEnv: 'MAD_SERVICE_URL',
  },
  {
    id: 'mad-auth',
    enabled: true,
    prefix: '/mad/auth',
    rewritePrefix: '/auth',
    upstreamEnv: 'MAD_SERVICE_URL',
  },
  ...['hw', 'fds', 'foss', 'kms', 'wkms'].map((id) => ({
    id,
    enabled: true,
    prefix: '/' + id,
    rewritePrefix: '/' + id,
    upstreamEnv: id.toUpperCase() + '_SERVICE_URL',
  })),
  {
    id: 'disabled',
    enabled: false,
    prefix: '/disabled',
    rewritePrefix: '/disabled',
    upstreamEnv: 'DISABLED_SERVICE_URL',
  },
];

async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  let ready = true;
  const calls: {
    path?: string;
    headers: IncomingMessage['headers'];
    body: string;
    service: string;
  }[] = [];
  const handler =
    (service: string) => (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health/ready') {
        res.writeHead(ready ? 200 : 503);
        res.end('{}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        calls.push({ path: req.url, headers: req.headers, body, service });
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
        res.setHeader('content-type', 'application/json');
        res.setHeader('set-cookie', 'unsafe=1');
        if (req.url?.endsWith('/denied')) {
          res.writeHead(401, {
            'www-authenticate': 'Bearer realm="subsystem"',
          });
          res.end('{"code":"LOCAL_SESSION_EXPIRED"}');
        } else if (req.url?.endsWith('/forbidden')) {
          res.writeHead(403);
          res.end(
            '{"code":"PASSWORD_CHANGE_REQUIRED","message":"Change your password."}',
          );
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  };
  for (const id of ['mad', 'hw', 'fds', 'foss', 'kms', 'wkms']) {
    env[id.toUpperCase() + '_SERVICE_URL'] = await server(t, handler(id));
  }
  const config = loadConfig(env, routes);
  Object.assign(config, overrides);
  const app = await buildApp(config, false);
  t.after(() => app.close());
  return {
    app,
    calls,
    config,
    outage: () => {
      ready = false;
    },
  };
}

test('MAD login rewrites the longest prefix and preserves raw bytes without central Auth', async (t) => {
  const { app, calls } = await fixture(t);
  const payload = '{ "username": "manager", "password": "fixture" }';
  const response = await app.inject({
    method: 'POST',
    url: '/mad/auth/login',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'forged',
      'x-user-role': 'MANAGER',
      'x-room-number': '201',
      'x-request-id': 'forged',
      'x-forwarded-for': '203.0.113.1',
      cookie: 'secret=1',
    },
    payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].path, '/auth/login');
  assert.equal(calls[0].body, payload);
  for (const header of ['x-user-id', 'x-user-role', 'x-room-number', 'cookie'])
    assert.equal(calls[0].headers[header], undefined);
  assert.notEqual(calls[0].headers['x-forwarded-for'], '203.0.113.1');
  assert.notEqual(calls[0].headers['x-request-id'], 'forged');
  assert.equal(
    calls[0].headers['x-request-id'],
    response.headers['x-request-id'],
  );
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('all six services receive their own login requests', async (t) => {
  const { app, calls } = await fixture(t);
  for (const id of ['mad', 'hw', 'fds', 'foss', 'kms', 'wkms']) {
    const response = await app.inject({
      method: 'POST',
      url: '/' + id + '/auth/login',
      payload: '{}',
    });
    assert.equal(response.statusCode, 200);
    const call = calls.at(-1)!;
    assert.equal(call.service, id);
    assert.equal(
      call.path,
      id === 'mad' ? '/auth/login' : '/' + id + '/auth/login',
    );
  }
});

test('query and opaque authorization are forwarded without JWT or role validation', async (t) => {
  const { app, calls } = await fixture(t);
  for (const authorization of [
    undefined,
    'Bearer malformed-token',
    'Basic opaque-credentials',
  ]) {
    const response = await app.inject({
      url: '/mad/analytics/bookings?period=week&value=a%2Fb',
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      calls.at(-1)!.path,
      '/mad/analytics/bookings?period=week&value=a%2Fb',
    );
    assert.equal(calls.at(-1)!.headers.authorization, authorization);
  }
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/mad/resource' })).statusCode,
    200,
  );
});

test('subsystem owns session and permission errors, including its error body', async (t) => {
  const { app } = await fixture(t);
  const denied = await app.inject({ url: '/mad/denied' });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body, '{"code":"LOCAL_SESSION_EXPIRED"}');
  assert.equal(denied.headers['www-authenticate'], 'Bearer realm="subsystem"');
  const forbidden = await app.inject({ url: '/mad/forbidden' });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, 'PASSWORD_CHANGE_REQUIRED');
});

test('bounded timeout, safe upstream errors and redirects', async (t) => {
  const { app } = await fixture(t, { upstreamTimeout: 100 });
  for (const [path, status] of [
    ['slow', 504],
    ['error', 503],
    ['redirect', 502],
  ] as const) {
    const response = await app.inject({ url: '/mad/' + path });
    assert.equal(response.statusCode, status);
    assert.ok(!response.body.includes('private'));
  }
});

test('unknown/disabled routes and ambiguous paths never reach an upstream', async (t) => {
  const { app, calls } = await fixture(t);
  for (const url of [
    '/disabled/rooms',
    '/madness',
    '/auth/login',
    '/identity/login',
  ])
    assert.equal((await app.inject({ url })).statusCode, 404);
  for (const url of ['/mad/%2e%2e/auth', '/mad//rooms'])
    assert.equal((await app.inject({ url })).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.throws(() => requestPath('/mad/../auth'));
  assert.throws(() => requestPath('/mad\\auth'));
});

test('request and response body limits remain enforced', async (t) => {
  const { app } = await fixture(t, { bodyLimit: 16, responseLimit: 8 });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/mad/auth/login',
        payload: 'x'.repeat(17),
      })
    ).statusCode,
    413,
  );
  assert.equal((await app.inject({ url: '/mad/resource' })).statusCode, 502);
});

test('login limits and downstream denials both consume the client quota', async (t) => {
  const { app } = await fixture(t, { loginMax: 1, rateMax: 2 });
  assert.equal(
    (await app.inject({ method: 'POST', url: '/mad/auth/login' })).statusCode,
    200,
  );
  const limited = await app.inject({ method: 'POST', url: '/mad/auth/login' });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  assert.equal(
    (await app.inject({ url: '/mad/denied', remoteAddress: '127.0.0.2' }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/mad/denied', remoteAddress: '127.0.0.2' }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/mad/denied', remoteAddress: '127.0.0.2' }))
      .statusCode,
    429,
  );
});

test('CORS restricts origins and permits approved authorization preflight', async (t) => {
  const { app, calls } = await fixture(t);
  assert.equal(
    (
      await app.inject({
        url: '/mad/resource',
        headers: { origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  );
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/mad/resource',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(
    response.headers['access-control-allow-origin'],
    'http://localhost:3000',
  );
  assert.equal(calls.length, 0);
});

test('health depends on enabled services without a central session lookup', async (t) => {
  const { app, outage } = await fixture(t);
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
  outage();
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 503);
  assert.equal((await app.inject({ url: '/health/live' })).statusCode, 200);
});

test('configuration needs no JWT settings and rejects obsolete policy fields', () => {
  const env = {
    MAD_SERVICE_URL: 'http://localhost:4000',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  };
  const madRoutes = routes.slice(0, 2);
  assert.equal(loadConfig(env, madRoutes).routes[0].id, 'mad-auth');
  assert.throws(() => loadConfig(env, [{ ...routes[0], roles: ['MANAGER'] }]));
  assert.throws(() =>
    loadConfig({ ...env, TRUSTED_PROXIES: '0.0.0.0/0' }, madRoutes),
  );
  assert.throws(() =>
    loadConfig(
      { ...env, MAD_SERVICE_URL: 'http://user:secret@localhost:4000' },
      madRoutes,
    ),
  );
  assert.throws(() =>
    loadConfig({ ...env, NODE_ENV: 'production' }, madRoutes),
  );
  assert.throws(() =>
    loadConfig(env, [...madRoutes, { ...routes[0], id: 'other' }]),
  );
});
