import { jwtVerify } from 'jose';
import type { Config, Role, Route, Access } from './config.ts';
import { ROLES } from './config.ts';
import {
  forbidden,
  unauthorized,
  unavailable,
  GatewayError,
} from './errors.ts';
import { boundedBody } from './http.ts';

export interface Principal {
  sub: string;
  role: Role;
  roomNumber?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function authenticate(
  config: Config,
  header: string | undefined,
  route: Route,
  method: string,
  access: Access,
  requestId?: string,
): Promise<Principal> {
  if (
    !header ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)
  )
    throw unauthorized();
  const token = header.slice(7);
  let principal: Principal;
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(config.secret),
      {
        algorithms: ['HS256'],
        issuer: config.issuer,
        requiredClaims: ['sub', 'iat', 'exp', 'role'],
      },
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== 'string' ||
      !uuid.test(payload.sub) ||
      !ROLES.includes(payload.role as Role) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat! > now
    )
      throw unauthorized();
    const lifetime = payload.exp! - payload.iat!;
    if (payload.role === 'GUEST') {
      if (
        lifetime <= 0 ||
        lifetime > 86400 ||
        typeof payload.roomNumber !== 'string' ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(payload.roomNumber)
      )
        throw unauthorized();
    } else if (lifetime !== 28800) throw unauthorized();
    principal = {
      sub: payload.sub,
      role: payload.role as Role,
      ...(payload.role === 'GUEST'
        ? { roomNumber: payload.roomNumber as string }
        : {}),
    };
  } catch {
    throw unauthorized();
  }
  if (
    !route.roles.includes(principal.role) &&
    !(
      route.readOnlyRoles.includes(principal.role) &&
      ['GET', 'HEAD'].includes(method)
    )
  )
    throw forbidden();
  // Permit a cryptographically valid logout to reach MAD even during Auth outage:
  // MAD records durable local revocation before it attempts central logout.
  if (access === 'logout') return principal;
  let state: Record<string, unknown>;
  try {
    const response = await fetch(config.authUrl + '/auth/session', {
      headers: { authorization: header, accept: 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(config.authTimeout),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw unauthorized();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const body: unknown = JSON.parse(
      (await boundedBody(response, 65536)).toString('utf8'),
    );
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw unavailable();
    state = body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 401) throw error;
    throw unavailable();
  }
  if (
    state.active !== true ||
    state.sub !== principal.sub ||
    state.role !== principal.role
  )
    throw unauthorized();
  if (principal.role === 'GUEST') {
    // Proposed provider contract for FOSS; route stays disabled until agreed.
    if (
      state.roomNumber !== principal.roomNumber ||
      state.activeStay !== true ||
      typeof state.checkoutAt !== 'string' ||
      !Number.isFinite(Date.parse(state.checkoutAt)) ||
      Date.parse(state.checkoutAt) <= Date.now()
    )
      throw unauthorized();
  } else {
    if (typeof state.passwordChangeRequired !== 'boolean') throw unavailable();
    if (state.passwordChangeRequired && access !== 'password-change')
      throw new GatewayError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'Change your password before accessing this service.',
      );
  }
  return principal;
}
