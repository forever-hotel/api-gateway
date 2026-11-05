import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { StaffAuth, authBody } from '../src/staff-auth.ts';
import { hashPassword, verifyPassword } from '../src/password.ts';
import { staffAuthConfig, type StaffAuthConfig } from '../src/staff-auth-config.ts';

const config: StaffAuthConfig = {
  databaseUrl: 'postgresql://unused:unused@localhost/test',
  ssl: false,
  secret: 'gateway-test-secret-at-least-32-characters',
  issuer: 'gateway-test',
  emailEnabled: false,
  brevoKey: '',
  sender: ''
};
const account = {
  worker_id: randomUUID(),
  username: 'manager',
  email: 'manager@example.invalid',
  role: 'MANAGER',
  is_active: true,
  password_hash: 'unused',
  password_change_required: false,
  session_version: 0,
  failed_attempts: 0,
  locked_until: null
};

function token(role = 'MANAGER', version = 0) {
  return new JwtService().sign(
    { sub: account.worker_id, role, ver: version, jti: randomUUID() },
    {
      secret: config.secret,
      issuer: config.issuer,
      audience: 'forever-hotel-staff',
      algorithm: 'HS256',
      expiresIn: '8h'
    }
  );
}
test('password verifier accepts existing scrypt and bcrypt staff credentials', async () => {
  const password = 'existing-private-password';

  for (const encoded of [await hashPassword(password), await hash(password, 12)]) {
    assert.equal(await verifyPassword(password, encoded), true);
    assert.equal(await verifyPassword('wrong', encoded), false);
  }
});
test('central auth rejects malformed, expired, forged and wrong-audience tokens before database access', async t => {
  const auth = new StaffAuth(config);

  t.after(() => auth.database.end());
  t.mock.method(auth.database, 'query', async () => {
    throw new Error('Database must not be reached');
  });
  const jwt = new JwtService();

  for (const value of [
    'bad',
    token().slice(0, -8) + 'tampered',
    jwt.sign(
      { sub: account.worker_id },
      { secret: config.secret, issuer: config.issuer, audience: 'guest', expiresIn: '8h' }
    ),
    jwt.sign(
      { sub: account.worker_id },
      { secret: config.secret, issuer: config.issuer, audience: 'forever-hotel-staff', expiresIn: -1 }
    )
  ]) {
    await assert.rejects(auth.session(value), error => (error as { status: number }).status === 401);
  }
});
test('session checks current account state, version, subsystem role and first-login gate', async t => {
  const auth = new StaffAuth(config);

  t.after(() => auth.database.end());
  let rows: unknown[] = [account];

  t.mock.method(auth.database, 'query', async () => ({ rows }));
  assert.equal((await auth.session(token(), 'mad', false)).role, 'MANAGER');
  await assert.rejects(auth.session(token(), 'wkms'), error => (error as { status: number }).status === 403);
  for (const changed of [
    { ...account, is_active: false },
    { ...account, session_version: 1 },
    { ...account, role: 'WORKER' }
  ]) {
    rows = [changed];
    await assert.rejects(auth.session(token()), error => (error as { status: number }).status === 401);
  }
  rows = [{ ...account, password_change_required: true }];
  assert.equal((await auth.session(token(), 'mad', true)).passwordChangeRequired, true);
  await assert.rejects(
    auth.session(token(), 'mad', false),
    error => (error as { code: string }).code === 'PASSWORD_CHANGE_REQUIRED'
  );
  rows = [];
  await assert.rejects(auth.session(token()), error => (error as { status: number }).status === 401);
});
test('recovery fails closed when sending is not configured and rejects invalid input', async t => {
  const auth = new StaffAuth(config);

  t.after(() => auth.database.end());
  await assert.rejects(
    auth.requestReset('manager@example.invalid'),
    error => (error as { status: number }).status === 503
  );
  await assert.rejects(
    auth.resetPassword({ email: 'manager@example.invalid', code: 'bad', newPassword: 'short' }),
    error => (error as { status: number }).status === 400
  );
  assert.throws(() => authBody(Buffer.from('{"role":"MANAGER"}'), ['username', 'password']));
});
test('staff auth configuration requires explicit strong signing and database settings', () => {
  assert.equal(staffAuthConfig({}), undefined);
  assert.throws(() => staffAuthConfig({ STAFF_AUTH_ENABLED: 'yes' }));
  assert.throws(() =>
    staffAuthConfig({
      STAFF_AUTH_ENABLED: 'true',
      DATABASE_URL: config.databaseUrl,
      JWT_SECRET: 'short',
      JWT_ISSUER: 'test'
    })
  );
  assert.equal(
    staffAuthConfig({
      STAFF_AUTH_ENABLED: 'true',
      DATABASE_URL: config.databaseUrl,
      JWT_SECRET: config.secret,
      JWT_ISSUER: config.issuer
    })?.issuer,
    config.issuer
  );
});

test('auth configuration validates database parts, TLS and email settings', () => {
  const base = {
    STAFF_AUTH_ENABLED: 'true',
    DB_HOST: 'localhost',
    DB_USERNAME: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    JWT_SECRET: config.secret,
    JWT_ISSUER: config.issuer
  };

  assert.equal(staffAuthConfig(base)?.ssl, false);
  assert.equal(
    staffAuthConfig({
      ...base,
      DB_SSL: 'true',
      STAFF_EMAIL_ENABLED: 'true',
      BREVO_API_KEY: 'test',
      STAFF_EMAIL_FROM: 'sender@example.invalid'
    })?.emailEnabled,
    true
  );
  for (const key of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'])
    assert.throws(() => staffAuthConfig({ ...base, [key]: '' }));
  for (const invalid of [
    { DB_HOST: 'bad/host' },
    { DB_PORT: '0' },
    { DB_PORT: 'bad' },
    { DB_PORT: '65536' },
    { DB_SSL: 'yes' },
    { STAFF_EMAIL_ENABLED: 'yes' },
    { DATABASE_URL: 'https://db.invalid' },
    { JWT_ISSUER: '' },
    { STAFF_EMAIL_ENABLED: 'true' },
    { STAFF_EMAIL_ENABLED: 'true', BREVO_API_KEY: 'test', STAFF_EMAIL_FROM: 'bad' }
  ])
    assert.throws(() => staffAuthConfig({ ...base, ...invalid }));
});
test('login enforces account lockout, supported roles and matching credentials', async t => {
  const auth = new StaffAuth(config);

  t.after(() => auth.database.end());
  const password = 'private-test-password';
  let current: Record<string, unknown> | undefined = { ...account, password_hash: await hashPassword(password) };
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT') && current ? [current] : [] };
    },
    release: () => {}
  };

  t.mock.method(auth.database, 'connect', async () => client as never);
  assert.equal((await auth.login({ username: 'manager', password }, 'mad')).role, 'MANAGER');
  await assert.rejects(auth.login({ username: 'manager', password: 'wrong' }, 'mad'));
  assert.ok(queries.some(sql => sql.includes('failed_attempts=$2')));
  for (const changed of [
    { ...current, is_active: false },
    { ...current, locked_until: new Date(Date.now() + 60000) },
    { ...current, role: 'GUEST' },
    undefined
  ]) {
    current = changed;
    await assert.rejects(auth.login({ username: 'manager', password }, 'mad'));
  }
  await assert.rejects(auth.login({ username: '', password }));
  await assert.rejects(auth.login({ username: 'manager', password }, 'unknown'));
});
test('provider/storage failures are sanitized while auth failures retain their status', async t => {
  const auth = new StaffAuth(config);

  t.after(() => auth.database.end());
  await assert.rejects(
    auth.safely(() => Promise.reject(new Error('private database credentials'))),
    error => (error as Error).message.indexOf('private') < 0
  );
  await assert.rejects(auth.session('invalid'));
});

test('multi-role sessions select subsystem permission and ROOT reaches every staff system', async t => {
  const auth = new StaffAuth(config);
  t.after(() => auth.database.end());
  let row = { ...account, roles: ['MANAGER', 'WORKER'] };
  t.mock.method(auth.database, 'query', async () => ({ rows: [row] }));
  assert.equal((await auth.session(token(), 'wkms', false)).role, 'WORKER');
  await assert.rejects(auth.session(token(), 'fds', false));
  row = { ...account, roles: ['ROOT'] };
  for (const system of ['mad', 'fds', 'wms', 'wkms', 'kms', 'hw', 'foss'])
    assert.equal((await auth.session(token('ROOT'), system, false)).role, 'ROOT');
});

test('only verified sessions receive independent request budgets', async t => {
  const auth = new StaffAuth(config);
  t.after(() => auth.database.end());
  assert.equal(auth.rateIdentity('forged'), undefined);
  const first = auth.rateIdentity(token());
  const second = auth.rateIdentity(token());
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test('password change retains the effective subsystem role for multi-role accounts', async t => {
  const auth = new StaffAuth(config);
  t.after(() => auth.database.end());
  const row = { ...account, role: 'RECEPTIONIST', roles: ['RECEPTIONIST', 'WORKER'], session_version: 1 };
  const client = { query: async () => ({ rows: [row] }) } as unknown as Parameters<StaffAuth['replacePassword']>[0];
  const changed = await auth.replacePassword(client, row, 'changed-private-password', 'wkms');
  assert.equal(changed.role, 'WORKER');
  assert.deepEqual(changed.roles, ['RECEPTIONIST', 'WORKER']);
});

test('password recovery restricts both steps to the requesting subsystem roles', async t => {
  for (const [system, expected] of [
    ['mad', ['ROOT', 'MANAGER']],
    ['fds', ['ROOT', 'RECEPTIONIST']],
    ['wms', ['ROOT', 'WORKER']],
    ['wkms', ['ROOT', 'WORKER']],
    ['kms', ['ROOT', 'KITCHEN_STAFF', 'KITCHEN_MANAGER']]
  ] as const) {
    const auth = new StaffAuth({ ...config, emailEnabled: true });
    t.after(() => auth.database.end());
    const selected: unknown[][] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (sql.includes('FROM public.staff_users')) {
          assert.ok(sql.includes('roles && $2::text[]'));
          selected.push(values!);
        }
        return { rows: [], rowCount: 0 };
      },
      release() {}
    };
    t.mock.method(auth.database, 'connect', async () => client);
    await auth.requestReset('person@example.invalid', system);
    await assert.rejects(
      auth.resetPassword(
        { email: 'person@example.invalid', code: '123456', newPassword: 'new-private-password' },
        system
      )
    );
    assert.equal(selected.length, 2);
    for (const values of selected) assert.deepEqual(values, ['person@example.invalid', expected]);
    await assert.rejects(
      auth.requestReset('person@example.invalid', 'unknown'),
      error => (error as { status: number }).status === 400
    );
  }
});
