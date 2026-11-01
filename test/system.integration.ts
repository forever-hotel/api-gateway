// Explicit cross-repository verification. Requires a built sibling MAD backend,
// TEST_DATABASE_URL and TEST_RABBITMQ_URL pointing only at disposable services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { hashPassword } from '../src/password.ts';

interface SharedApp {
  listen(port: number, host: string): Promise<void>;
  getUrl(): Promise<string>;
  get(token: unknown): unknown;
  close(): Promise<void>;
}
interface ClientSocket {
  connect(): void;
  disconnect(): void;
  once(name: string, listener: (value: unknown) => void): void;
  emit(name: string, ...args: unknown[]): void;
}
test(
  'real central JWT -> gateway WebSocket -> shared service -> RabbitMQ invalidation and logout',
  {
    timeout:
      process.env.RUN_PERFORMANCE_BURSTS === 'true'
        ? ((Number(process.env.PERFORMANCE_ROUNDS ?? 5) + Number(process.env.PERFORMANCE_WARMUP_ROUNDS ?? 5)) * 2 +
            120) *
          1000
        : 45000
  },
  async t => {
    const url = process.env.TEST_DATABASE_URL ?? '',
      broker = process.env.TEST_RABBITMQ_URL ?? '';

    assert.ok(new URL(url).pathname.includes('test'));
    assert.equal(new URL(broker).pathname, '/mad_test');
    const backend = resolve(process.env.MAD_BACKEND_PATH ?? '../backend');
    const requireBackend = createRequire(resolve(backend, 'package.json'));
    const { NestFactory } = requireBackend('@nestjs/core') as {
      NestFactory: { create(module: unknown, options: { logger: false }): Promise<SharedApp> };
    };
    const { ConfigService } = requireBackend('@nestjs/config') as {
      ConfigService: new (values: Record<string, string>) => unknown;
    };
    const { io } = requireBackend('socket.io-client') as { io: (url: string, options: unknown) => ClientSocket };
    const admin = new Pool({ connectionString: url });
    const name = 'system_test_' + randomUUID().replaceAll('-', '');

    await admin.query('CREATE DATABASE "' + name + '"');
    const dburl = new URL(url);

    dburl.pathname = '/' + name;
    const database = new Pool({ connectionString: dburl.toString() });
    const resources: {
      shared?: SharedApp;
      relay?: { send: (name: string, data: unknown) => Promise<void>; onModuleDestroy: () => Promise<void> };
      client?: ClientSocket;
    } = {};
    const previous = { broker: process.env.RABBITMQ_URL, systems: process.env.WEBSOCKET_SUBSYSTEMS_JSON };

    t.after(async () => {
      resources.client?.disconnect();
      await resources.relay?.onModuleDestroy();
      await resources.shared?.close();
      await database.end();
      await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
      await admin.end();
      if (previous.broker === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = previous.broker;
      if (previous.systems === undefined) delete process.env.WEBSOCKET_SUBSYSTEMS_JSON;
      else process.env.WEBSOCKET_SUBSYSTEMS_JSON = previous.systems;
    });
    const id = randomUUID(),
      password = 'system-private-password';

    await database.query(`CREATE TABLE staff_users(worker_id uuid PRIMARY KEY,username text,email text,password_hash text,role text,is_active boolean,password_change_required boolean,session_version integer,failed_attempts integer,locked_until timestamptz,updated_at timestamptz);
    CREATE TABLE mad_revoked_sessions(token_hash text PRIMARY KEY,expires_at timestamptz);`);
    await database.query(
      "INSERT INTO staff_users VALUES($1,'manager','manager@example.invalid',$2,'MANAGER',true,false,0,0,NULL,now())",
      [id, await hashPassword(password)]
    );
    const config = loadConfig({ ALLOWED_ORIGINS: 'http://localhost:3000', WS_URL: 'http://127.0.0.1:1' }, [
      { id: 'shared', enabled: true, prefix: '/realtime', rewritePrefix: '', upstreamEnv: 'WS_URL', websocket: true }
    ]);

    config.rateMax = 100000; // Measure authentication capacity independently of the separately tested IP limiter.
    config.staffAuth = {
      databaseUrl: dburl.toString(),
      ssl: false,
      secret: 'system-test-secret-at-least-32-characters',
      issuer: 'system-test',
      emailEnabled: false,
      sendgridKey: '',
      sender: ''
    };
    const gateway = await buildApp(config, false);

    t.after(() => gateway.close());
    await gateway.listen(0, '127.0.0.1');
    const gatewayUrl = await gateway.getUrl();

    t.diagnostic('gateway listening');
    const login = await fetch(gatewayUrl + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password, subsystem: 'mad' })
    });

    assert.equal(login.status, 200);
    const { accessToken } = (await login.json()) as { accessToken: string };

    t.diagnostic('central login succeeded');
    process.env.RABBITMQ_URL = broker;
    const key = 'system-relay-key-with-at-least-32-characters';

    process.env.WEBSOCKET_SUBSYSTEMS_JSON = JSON.stringify({
      mad: {
        authUrl: gatewayUrl + '/auth/session',
        relayKey: key,
        origins: ['http://localhost:3000'],
        roles: { MANAGER: ['rooms'] }
      }
    });
    const { SharedWebsocketModule } = requireBackend('./dist/shared-websocket/main.js') as {
      SharedWebsocketModule: unknown;
    };
    const { SharedBroker } = requireBackend('./dist/shared-websocket/shared-broker.service.js') as {
      SharedBroker: unknown;
    };
    const shared = await NestFactory.create(SharedWebsocketModule, { logger: false });

    resources.shared = shared;
    await shared.listen(0, '127.0.0.1');
    const sharedUrl = await shared.getUrl();

    config.routes[0].upstream = sharedUrl;
    const receiver = shared.get(SharedBroker) as { ready: boolean };
    const deadline = Date.now() + 10000;

    while (!receiver.ready && Date.now() < deadline) await pause(50);
    assert.ok(receiver.ready);
    t.diagnostic('shared service and broker ready');
    const ticketResponse = await fetch(sharedUrl + '/internal/tickets/mad', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + accessToken, 'x-relay-key': key }
    });

    assert.equal(ticketResponse.status, 201);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const client = io(gatewayUrl, {
      path: '/realtime/socket.io',
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Origin: 'http://localhost:3000' },
      auth: { ticket },
      reconnection: false
    });

    resources.client = client;
    const connected = new Promise((resolve, reject) => {
      client!.once('connect', resolve);
      client!.once('connect_error', reject);
    });

    client.connect();
    await connected;
    t.diagnostic('authenticated gateway socket connected');
    const denied = new Promise<{ ok: boolean }>(resolve => client!.emit('subscribe', ['kitchen'], resolve));

    assert.equal((await denied).ok, false);
    t.diagnostic('subscription permissions verified');
    const { RealtimeGateway } = requireBackend('./dist/realtime/realtime.gateway.js') as {
      RealtimeGateway: new (config: unknown) => NonNullable<typeof resources.relay>;
    };
    const relay = new RealtimeGateway(new ConfigService({ RABBITMQ_URL: broker, MAD_REALTIME_ENABLED: 'true' }));

    resources.relay = relay;
    const received = new Promise(resolve => client!.once('room.status.changed', resolve));
    const sentAt = performance.now();

    await relay.send('room.status.changed', { roomId: randomUUID(), privateNote: 'must-not-reach-client' });
    assert.deepEqual(await received, { changed: true });
    t.diagnostic('broker invalidation received');
    assert.ok(performance.now() - sentAt < 2000, 'NFR-03: local event reaches the client within two seconds');
    if (process.env.RUN_PERFORMANCE_BURSTS === 'true') {
      // Approved profile: one persistent socket and one request/second/client.
      // Five measured seconds locally; use 900 for a 15-minute staging soak.
      const rounds = Number(process.env.PERFORMANCE_ROUNDS ?? 5);
      const warmup = Number(process.env.PERFORMANCE_WARMUP_ROUNDS ?? 5);

      assert.ok(Number.isInteger(warmup) && warmup >= 1 && warmup <= 600);
      assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 3600);
      for (const users of [100, 300]) {
        const sockets: ClientSocket[] = [];

        try {
          // Ramp connections before measurement instead of opening hundreds in one tick.
          for (let joined = 0; joined < users; joined += 20) {
            await Promise.all(
              Array.from({ length: Math.min(20, users - joined) }, async () => {
                const response = await fetch(sharedUrl + '/internal/tickets/mad', {
                  method: 'POST',
                  headers: { authorization: 'Bearer ' + accessToken, 'x-relay-key': key }
                });

                assert.equal(response.status, 201);
                const { ticket } = (await response.json()) as { ticket: string };
                const socket = io(gatewayUrl, {
                  path: '/realtime/socket.io',
                  autoConnect: false,
                  transports: ['websocket'],
                  extraHeaders: { Origin: 'http://localhost:3000' },
                  auth: { ticket },
                  reconnection: false
                });

                sockets.push(socket);
                const ready = new Promise((resolve, reject) => {
                  socket.once('connect', resolve);
                  socket.once('connect_error', reject);
                });

                socket.connect();
                await ready;
              })
            );
          }
          const durations: number[] = [];

          for (let round = 0; round < rounds + warmup; round++) {
            await Promise.all(
              Array.from({ length: users }, async (_, index) => {
                await pause((index * 1000) / users);
                const started = performance.now();
                const response = await fetch(gatewayUrl + '/auth/session', {
                  headers: { authorization: 'Bearer ' + accessToken }
                });

                assert.equal(response.status, 200);
                await response.arrayBuffer();
                if (round >= warmup) durations.push(performance.now() - started);
              })
            );
          }
          durations.sort((a, b) => a - b);
          const p95 = durations[Math.ceil(durations.length * 0.95) - 1];

          t.diagnostic(
            `Local approved profile: ${users} clients/sockets, ${rounds} seconds, p95=${p95.toFixed(1)}ms, zero errors`
          );
          assert.ok(p95 <= 500, `NFR-01/14: p95 must be within 500ms at ${users} clients`);
          const updated = Promise.all(
            sockets.map(socket => new Promise(resolve => socket.once('room.status.changed', resolve)))
          );
          const started = performance.now();

          await relay.send('room.status.changed', {});
          await updated;
          assert.ok(performance.now() - started < 2000, 'NFR-03: update all connected dashboards within two seconds');
        } finally {
          for (const socket of sockets) socket.disconnect();
        }
      }
    }
    const logout = await fetch(gatewayUrl + '/auth/logout', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + accessToken }
    });

    assert.equal(logout.status, 200);
    const invalid = await fetch(gatewayUrl + '/auth/session', { headers: { authorization: 'Bearer ' + accessToken } });

    assert.equal(invalid.status, 401);
    const disconnected = new Promise(resolve => client!.once('disconnect', resolve));
    const { SharedGateway } = requireBackend('./dist/shared-websocket/shared.gateway.js') as { SharedGateway: unknown };

    await (shared.get(SharedGateway) as { revalidate(): Promise<void> }).revalidate();
    await disconnected;
  }
);
