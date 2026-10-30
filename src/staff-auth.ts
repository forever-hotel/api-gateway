import { JwtService } from '@nestjs/jwt';
import { Pool, type PoolClient } from 'pg';
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StaffAuthConfig } from './staff-auth-config.ts';
import { GatewayError, unavailable } from './errors.ts';
import { hashPassword, validPassword, verifyPassword } from './password.ts';

export const staffPermissions: Record<string, readonly string[]> = {
  mad: ['MANAGER'],
  fds: ['RECEPTIONIST'],
  kms: ['KITCHEN_STAFF', 'KITCHEN_MANAGER'],
  wkms: ['WORKER']
};
const roles = new Set(Object.values(staffPermissions).flat());
interface Account {
  worker_id: string;
  username: string;
  email: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  password_change_required: boolean;
  session_version: number;
  failed_attempts: number;
  locked_until: Date | null;
}
interface Claims {
  sub: string;
  role: string;
  ver: number;
  exp: number;
  iat: number;
  jti: string;
}
export interface StaffSession {
  sub: string;
  username: string;
  role: string;
  expiresAt: number;
  passwordChangeRequired: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const invalidCredentials = () =>
  new GatewayError(401, 'UNAUTHENTICATED', 'Unable to sign in. Check your details.');
export const invalidInput = (message = 'The request is invalid.') => new GatewayError(400, 'VALIDATION_ERROR', message);

export function authBody(raw: unknown, allowed: string[]): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw instanceof Buffer ? raw.toString('utf8') : '');

    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const body = value as Record<string, unknown>;

    if (
      Object.keys(body).some(key => !allowed.includes(key)) ||
      Object.values(body).some(value => typeof value !== 'string' || value.length > 1024)
    )
      throw new Error();
    return body as Record<string, string>;
  } catch {
    throw invalidInput();
  }
}

export class StaffAuth {
  readonly database: Pool;
  private readonly jwt = new JwtService();

  constructor(
    readonly config: StaffAuthConfig,
    private readonly report: (event: string) => void = () => {}
  ) {
    this.database = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      max: 10,
      connectionTimeoutMillis: 15000,
      statement_timeout: 5000,
      idleTimeoutMillis: 30000
    });
    // Pool errors must not expose connection credentials or terminate the process.
    this.database.on('error', () => {});
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private claims(token: string): Claims {
    try {
      const claims = this.jwt.verify<Claims>(token, {
        secret: this.config.secret,
        algorithms: ['HS256'],
        issuer: this.config.issuer,
        audience: ['forever-hotel-staff', 'mad']
      });
      const now = Math.floor(Date.now() / 1000);

      if (
        !uuid.test(claims.sub) ||
        !uuid.test(claims.jti) ||
        !roles.has(claims.role) ||
        !Number.isSafeInteger(claims.ver) ||
        claims.ver < 0 ||
        !Number.isInteger(claims.iat) ||
        !Number.isInteger(claims.exp) ||
        claims.iat > now ||
        claims.exp <= now ||
        claims.exp - claims.iat !== 28800
      )
        throw new Error();
      return claims;
    } catch {
      throw invalidCredentials();
    }
  }

  private describe(account: Account, claims: Claims): StaffSession {
    if (!account.is_active || account.role !== claims.role || account.session_version !== claims.ver)
      throw invalidCredentials();
    return {
      sub: account.worker_id,
      username: account.username,
      role: account.role,
      expiresAt: claims.exp,
      passwordChangeRequired: account.password_change_required
    };
  }

  private issue(account: Account) {
    const accessToken = this.jwt.sign(
      { sub: account.worker_id, role: account.role, ver: account.session_version, jti: randomUUID() },
      {
        secret: this.config.secret,
        issuer: this.config.issuer,
        audience: 'forever-hotel-staff',
        algorithm: 'HS256',
        expiresIn: '8h'
      }
    );

    return { accessToken, ...this.describe(account, this.claims(accessToken)) };
  }

  private locked(account: Account) {
    return account.locked_until && new Date(account.locked_until).getTime() > Date.now();
  }

  private async failure(client: PoolClient, account: Account) {
    const attempts = account.locked_until ? 1 : account.failed_attempts + 1;

    await client.query(
      "UPDATE public.staff_users SET failed_attempts=$2,locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now() WHERE worker_id=$1",
      [account.worker_id, attempts]
    );
  }

  async session(token: string, subsystem?: string, allowPasswordChange = true): Promise<StaffSession> {
    const claims = this.claims(token);
    const { rows } = await this.database.query<Account>(
      'SELECT a.* FROM public.staff_users a WHERE worker_id=$1 AND NOT EXISTS (SELECT 1 FROM public.mad_revoked_sessions WHERE token_hash=$2)',
      [claims.sub, this.digest(token)]
    );

    if (!rows[0]) throw invalidCredentials();
    const session = this.describe(rows[0], claims);

    if (subsystem && !staffPermissions[subsystem]?.includes(session.role))
      throw new GatewayError(403, 'FORBIDDEN', 'You do not have access to this subsystem.');
    if (!allowPasswordChange && session.passwordChangeRequired)
      throw new GatewayError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before opening the dashboard.');
    return session;
  }

  async login(body: Record<string, string>, subsystem?: string) {
    if (!body.username?.trim() || body.username.length > 100 || !body.password) throw invalidInput();
    if (subsystem && !staffPermissions[subsystem]) throw invalidInput();
    const result = await this.transaction(async client => {
      const { rows } = await client.query<Account>('SELECT * FROM public.staff_users WHERE username=$1 FOR UPDATE', [
        body.username.trim().toLowerCase()
      ]);
      const account = rows[0];
      const valid = await verifyPassword(body.password, account?.password_hash);

      if (!account || !account.is_active || !roles.has(account.role) || this.locked(account)) return null;
      if (!valid) {
        await this.failure(client, account);
        return null;
      }
      if (subsystem && !staffPermissions[subsystem].includes(account.role))
        throw new GatewayError(403, 'FORBIDDEN', 'You do not have access to this subsystem.');
      await client.query(
        'UPDATE public.staff_users SET failed_attempts=0,locked_until=NULL,updated_at=now() WHERE worker_id=$1',
        [account.worker_id]
      );
      return this.issue(account);
    });

    if (!result) throw invalidCredentials();
    return result;
  }

  async changePassword(token: string, body: Record<string, string>) {
    if (!body.currentPassword || !validPassword(body.newPassword ?? ''))
      throw invalidInput('Use a password with 12 to 1024 characters.');
    const session = await this.session(token);
    const result = await this.transaction(async client => {
      const { rows } = await client.query<Account>('SELECT * FROM public.staff_users WHERE worker_id=$1 FOR UPDATE', [
        session.sub
      ]);
      const account = rows[0];

      if (!account) throw invalidCredentials();
      this.describe(account, this.claims(token));
      if (this.locked(account)) throw invalidCredentials();
      const revoked = await client.query('SELECT token_hash FROM public.mad_revoked_sessions WHERE token_hash=$1', [
        this.digest(token)
      ]);

      if (revoked.rowCount) throw invalidCredentials();
      if (!(await verifyPassword(body.currentPassword, account.password_hash))) {
        await this.failure(client, account);
        return null;
      }
      if (await verifyPassword(body.newPassword, account.password_hash))
        throw invalidInput('Choose a different password from your current password.');
      return this.replacePassword(client, account, body.newPassword);
    });

    if (!result) throw invalidCredentials();
    return result;
  }

  async replacePassword(client: PoolClient, account: Account, password: string) {
    const { rows } = await client.query<Account>(
      'UPDATE public.staff_users SET password_hash=$2,password_change_required=false,session_version=session_version+1,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE worker_id=$1 RETURNING *',
      [account.worker_id, await hashPassword(password)]
    );

    return this.issue(rows[0]);
  }

  async logout(token: string) {
    const claims = this.claims(token);

    await this.database.query(
      'INSERT INTO public.mad_revoked_sessions(token_hash,expires_at) VALUES ($1,to_timestamp($2)) ON CONFLICT DO NOTHING',
      [this.digest(token), claims.exp]
    );
    return { status: 'signed_out' };
  }

  private codeHash(id: string, code: string) {
    return createHmac('sha256', this.config.secret)
      .update(id + ':' + code)
      .digest('hex');
  }

  async requestReset(email: string) {
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw invalidInput('Enter a valid email address.');
    if (!this.config.emailEnabled) throw unavailable();
    const code = randomInt(0, 1000000).toString().padStart(6, '0');
    const challenge = randomUUID();
    const delivery = await this.transaction(async client => {
      const { rows } = await client.query<Account>(
        "SELECT * FROM public.staff_users WHERE lower(email)=$1 AND role='MANAGER' AND is_active=true FOR UPDATE",
        [email.trim().toLowerCase()]
      );

      if (!rows[0]) return null;
      const result = await client.query(
        `INSERT INTO public.gateway_password_resets(worker_id,challenge_id,code_hash,expires_at,attempts,created_at,credential_version)
        VALUES ($1,$2,$3,now()+interval '10 minutes',0,now(),$4)
        ON CONFLICT (worker_id) DO UPDATE SET challenge_id=EXCLUDED.challenge_id,code_hash=EXCLUDED.code_hash,
          expires_at=EXCLUDED.expires_at,attempts=0,created_at=now(),credential_version=EXCLUDED.credential_version
        WHERE gateway_password_resets.created_at < now()-interval '60 seconds' RETURNING worker_id`,
        [rows[0].worker_id, challenge, this.codeHash(challenge, code), rows[0].session_version]
      );

      return result.rowCount ? rows[0] : null;
    });

    if (delivery) {
      try {
        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: { Authorization: 'Bearer ' + this.config.sendgridKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: delivery.email }] }],
            from: { email: this.config.sender },
            subject: 'Forever Hotel manager password reset',
            content: [
              {
                type: 'text/plain',
                value: `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email. Never share this code.`
              }
            ],
            tracking_settings: {
              click_tracking: { enable: false, enable_text: false },
              open_tracking: { enable: false }
            }
          })
        });

        await response.body?.cancel();
        if (response.status !== 202) throw new Error();
      } catch {
        await this.database.query('DELETE FROM public.gateway_password_resets WHERE worker_id=$1 AND challenge_id=$2', [
          delivery.worker_id,
          challenge
        ]);
        this.report('manager_reset_email_not_accepted');
        // Return the same public response for unknown accounts and provider failures.
        // Provider delivery/activity is checked in SendGrid, without exposing account existence.
      }
    }
    return {
      status: 'code_requested',
      message: 'If an active manager account matches, a code will be emailed. Check your inbox and spam folder.'
    };
  }

  async resetPassword(body: Record<string, string>) {
    if (
      !body.email ||
      body.email.length > 320 ||
      !/^[0-9]{6}$/.test(body.code ?? '') ||
      !validPassword(body.newPassword ?? '')
    )
      throw invalidInput('Enter your email, six-digit code and a new password of at least 12 characters.');
    const result = await this.transaction(async client => {
      const { rows } = await client.query<Account>(
        "SELECT * FROM public.staff_users WHERE lower(email)=$1 AND role='MANAGER' AND is_active=true FOR UPDATE",
        [body.email.trim().toLowerCase()]
      );
      const account = rows[0];

      if (!account) return false;
      const reset = await client.query<{ challenge_id: string; code_hash: string; credential_version: number }>(
        `SELECT challenge_id,code_hash,credential_version FROM public.gateway_password_resets
        WHERE worker_id=$1 AND expires_at>now() AND attempts<5 FOR UPDATE`,
        [account.worker_id]
      );
      const record = reset.rows[0];

      if (!record || record.credential_version !== account.session_version) return false;
      const valid = timingSafeEqual(
        Buffer.from(record.code_hash, 'hex'),
        Buffer.from(this.codeHash(record.challenge_id, body.code), 'hex')
      );

      if (!valid) {
        await client.query('UPDATE public.gateway_password_resets SET attempts=attempts+1 WHERE worker_id=$1', [
          account.worker_id
        ]);
        return false;
      }
      if (await verifyPassword(body.newPassword, account.password_hash))
        throw invalidInput('Choose a different password from your current password.');
      // Reset is recovery, not automatic sign-in. Incrementing the version revokes all previous sessions.
      await client.query(
        'UPDATE public.staff_users SET password_hash=$2,password_change_required=false,session_version=session_version+1,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE worker_id=$1',
        [account.worker_id, await hashPassword(body.newPassword)]
      );
      await client.query('DELETE FROM public.gateway_password_resets WHERE worker_id=$1', [account.worker_id]);
      return true;
    });

    if (!result) throw invalidInput('The code is invalid or expired. Request another code.');
    return { status: 'password_reset', message: 'Password changed. Sign in with your new password.' };
  }

  async safely<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw unavailable();
    }
  }
}
