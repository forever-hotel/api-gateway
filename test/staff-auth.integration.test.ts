import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaffAuth } from '../src/staff-auth.ts';
import { hashPassword } from '../src/password.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

test(
  'central staff login, manager recovery and durable revocation on disposable PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async t => {
    const url = process.env.TEST_DATABASE_URL!;

    assert.ok(new URL(url).pathname.includes('test'), 'Only a disposable test database is allowed');
    const admin = new Pool({ connectionString: url });
    const name = 'gateway_auth_test_' + randomUUID().replaceAll('-', '');

    await admin.query('CREATE DATABASE "' + name + '"');
    const isolated = new URL(url);

    isolated.pathname = '/' + name;
    const config = {
      databaseUrl: isolated.toString(),
      ssl: false,
      secret: 'integration-secret-with-at-least-32-characters',
      issuer: 'gateway-test',
      emailEnabled: true,
      sendgridKey: 'test-only',
      sender: 'sender@example.invalid'
    };
    const auth = new StaffAuth(config);

    t.after(async () => {
      await auth.database.end();
      await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
      await admin.end();
    });
    await auth.database
      .query(`CREATE TABLE public.staff_users(worker_id uuid PRIMARY KEY,username text UNIQUE,email text UNIQUE,password_hash text,role text,is_active boolean DEFAULT true,password_change_required boolean DEFAULT false,session_version integer DEFAULT 0,failed_attempts integer DEFAULT 0,locked_until timestamptz,updated_at timestamptz DEFAULT now());
    CREATE TABLE public.mad_revoked_sessions(token_hash text PRIMARY KEY,expires_at timestamptz NOT NULL);`);
    await auth.database.query(readFileSync('sql/manager-password-reset.sql', 'utf8'));
    const password = 'initial-private-password';
    const ids = new Map<string, string>();

    for (const [role, subsystem] of [
      ['MANAGER', 'mad'],
      ['RECEPTIONIST', 'fds'],
      ['WORKER', 'wkms'],
      ['KITCHEN_STAFF', 'kms'],
      ['KITCHEN_MANAGER', 'kms']
    ]) {
      const id = randomUUID();

      ids.set(role, id);
      await auth.database.query(
        'INSERT INTO public.staff_users(worker_id,username,email,password_hash,role,password_change_required) VALUES($1,$2,$3,$4,$5,true)',
        [
          id,
          role.toLowerCase(),
          role.toLowerCase() + '@example.invalid',
          role === 'MANAGER' ? await hashPassword(password) : await hash(password, 12),
          role
        ]
      );
      const login = await auth.login({ username: role.toLowerCase(), password }, subsystem);

      assert.equal(login.passwordChangeRequired, true);
      await assert.rejects(auth.session(login.accessToken, subsystem, false));
      const changed = await auth.changePassword(login.accessToken, {
        currentPassword: password,
        newPassword: 'changed-private-password'
      });

      assert.equal(changed.passwordChangeRequired, false);
      await assert.rejects(auth.session(login.accessToken));
      await auth.logout(changed.accessToken);
      await assert.rejects(auth.session(changed.accessToken));
    }
    const manager = await auth.login({ username: 'manager', password: 'changed-private-password' }, 'mad');

    await assert.rejects(
      auth.changePassword(manager.accessToken, {
        currentPassword: 'changed-private-password',
        newPassword: 'changed-private-password'
      })
    );
    let code = '';

    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { content: { value: string }[] };

      code = body.content[0].value.match(/code is ([0-9]{6})/)![1];
      return new Response(null, { status: 202 });
    });
    await auth.requestReset('manager@example.invalid');
    assert.match(code, /^[0-9]{6}$/);
    const [{ code_hash }] = (await auth.database.query('SELECT code_hash FROM public.gateway_password_resets')).rows;

    assert.notEqual(code_hash, code);
    const body = { email: 'manager@example.invalid', code, newPassword: 'recovered-private-password' };

    await assert.rejects(auth.resetPassword({ ...body, newPassword: 'changed-private-password' }));
    const results = await Promise.allSettled([auth.resetPassword(body), auth.resetPassword(body)]);

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    await assert.rejects(auth.session(manager.accessToken));
    await auth.login({ username: 'manager', password: body.newPassword }, 'mad');
    // Recovery expiry and attempt budgets are persisted, not process-local.
    await auth.requestReset('manager@example.invalid');
    const attemptsBody = { email: 'manager@example.invalid', code, newPassword: 'another-private-password' };
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(auth.resetPassword({ ...attemptsBody, code: wrong }));
    await assert.rejects(auth.resetPassword(attemptsBody));
    const attempts = await auth.database.query('SELECT attempts FROM public.gateway_password_resets');

    assert.equal(attempts.rows[0].attempts, 5);
    await auth.database.query(
      "UPDATE public.gateway_password_resets SET attempts=0,created_at=now()-interval '12 minutes',expires_at=now()-interval '2 minutes'"
    );
    await assert.rejects(auth.resetPassword(attemptsBody));
    // A non-manager can never obtain a manager recovery code.
    code = '';
    await auth.requestReset('worker@example.invalid');
    assert.equal(code, '');
    // Real transport endpoints handle auth locally and protect business routes.
    const gateway = await buildApp(
      {
        ...loadConfig({ ALLOWED_ORIGINS: 'http://localhost:3000', MAD_SERVICE_URL: 'http://127.0.0.1:1' }, [
          { id: 'mad', enabled: true, prefix: '/mad', rewritePrefix: '/mad', upstreamEnv: 'MAD_SERVICE_URL' }
        ]),
        staffAuth: config
      },
      false
    );

    t.after(() => gateway.close());
    const server = gateway.getHttpAdapter().getInstance();

    await server.ready();
    const logged = await server.inject({
      method: 'POST',
      url: '/mad/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'manager', password: body.newPassword })
    });

    assert.equal(logged.statusCode, 200);
    assert.equal((await server.inject({ url: '/mad/analytics/overview' })).statusCode, 401);
  }
);
