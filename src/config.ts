import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const ROLES = [
  'MANAGER',
  'RECEPTIONIST',
  'KITCHEN_STAFF',
  'KITCHEN_MANAGER',
  'WORKER',
  'GUEST',
] as const;
export type Role = (typeof ROLES)[number];
export const METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export type Access = 'public' | 'protected' | 'password-change' | 'logout';
export interface Endpoint {
  path: string;
  method: string;
  access: Access;
}
export interface Route {
  id: string;
  prefix: string;
  rewritePrefix: string;
  upstream: string;
  roles: Role[];
  readOnlyRoles: Role[];
  endpoints: Endpoint[];
}
export interface Config {
  production: boolean;
  host: string;
  port: number;
  logLevel: string;
  secret: string;
  issuer: string;
  authUrl: string;
  origins: string[];
  trustedProxies: string[];
  redisUrl?: string;
  rateMax: number;
  loginMax: number;
  windowMs: number;
  bodyLimit: number;
  responseLimit: number;
  upstreamTimeout: number;
  authTimeout: number;
  routes: Route[];
}
function invalid(name: string): never {
  throw new Error(`Configuration: invalid or missing ${name}`);
}
function origin(value: string | undefined, name: string) {
  try {
    const url = new URL(value ?? '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return invalid(name);
    return url.origin;
  } catch {
    return invalid(name);
  }
}
function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\/[a-zA-Z0-9/_-]+$/.test(value) &&
    !value.endsWith('/') &&
    !value.includes('//')
  );
}
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  source?: unknown,
): Config {
  const required = (name: string) => env[name]?.trim() || invalid(name);
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      return invalid(name);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  if (
    env.NODE_ENV &&
    !['development', 'test', 'production'].includes(env.NODE_ENV)
  )
    invalid('NODE_ENV');
  const secret = required('JWT_SECRET');
  if (
    Buffer.byteLength(secret) < 32 ||
    (production && secret.startsWith('local-only-'))
  )
    invalid('JWT_SECRET');
  const origins = required('ALLOWED_ORIGINS')
    .split(',')
    .map((item) => origin(item.trim(), 'ALLOWED_ORIGINS'));
  if (production && origins.some((item) => !item.startsWith('https://')))
    invalid('ALLOWED_ORIGINS (HTTPS in production)');
  const trustedProxies = (env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const address of trustedProxies) {
    const [ip, mask, extra] = address.split('/');
    const family = isIP(ip);
    if (
      !family ||
      extra !== undefined ||
      (mask !== undefined &&
        (!/^\d+$/.test(mask) ||
          Number(mask) < 1 ||
          Number(mask) > (family === 4 ? 32 : 128)))
    )
      invalid('TRUSTED_PROXIES');
  }
  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (production && !redisUrl) invalid('REDIS_URL (required in production)');
  if (redisUrl) {
    try {
      if (!['redis:', 'rediss:'].includes(new URL(redisUrl).protocol))
        invalid('REDIS_URL');
    } catch {
      invalid('REDIS_URL');
    }
  }
  let raw: unknown = source;
  if (raw === undefined) {
    try {
      raw = JSON.parse(
        readFileSync(env.ROUTES_FILE || 'config/routes.json', 'utf8'),
      );
    } catch {
      invalid('ROUTES_FILE');
    }
  }
  if (!Array.isArray(raw) || !raw.length) invalid('ROUTES_FILE');
  const roles = (value: unknown): Role[] => {
    if (
      !Array.isArray(value) ||
      value.some((role) => !ROLES.includes(role as Role))
    )
      invalid('route roles');
    return value as Role[];
  };
  const routes: Route[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean')
      invalid('route enabled');
    if (!item.enabled) continue;
    if (
      typeof item.id !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(item.id) ||
      !path(item.prefix) ||
      !path(item.rewritePrefix)
    )
      invalid('route id/prefix');
    if (item.prefix === '/health' || item.prefix.startsWith('/health/'))
      invalid('reserved health prefix');
    if (
      routes.some(
        (route) =>
          route.id === item.id ||
          route.prefix === item.prefix ||
          route.prefix.startsWith(item.prefix + '/') ||
          (item.prefix as string).startsWith(route.prefix + '/'),
      )
    )
      invalid('overlapping routes');
    if (
      typeof item.upstreamEnv !== 'string' ||
      !/^[A-Z_]+$/.test(item.upstreamEnv)
    )
      invalid('route upstreamEnv');
    const upstream = origin(env[item.upstreamEnv], item.upstreamEnv);
    if (!Array.isArray(item.endpoints)) invalid('route endpoints');
    const endpoints = item.endpoints as Endpoint[];
    for (const endpoint of endpoints) {
      if (
        !endpoint ||
        !path(endpoint.path) ||
        !METHODS.includes(endpoint.method as (typeof METHODS)[number]) ||
        !['public', 'protected', 'password-change', 'logout'].includes(
          endpoint.access,
        )
      )
        invalid('route endpoint');
      if (
        endpoints.filter(
          (other) =>
            other.path === endpoint.path && other.method === endpoint.method,
        ).length !== 1
      )
        invalid('duplicate endpoint');
      if (endpoint.access === 'logout' && endpoint.method !== 'POST')
        invalid('logout method');
    }
    const allowed = roles(item.roles),
      readOnly = roles(item.readOnlyRoles);
    if (!allowed.length && !readOnly.length) invalid('empty role policy');
    routes.push({
      id: item.id,
      prefix: item.prefix,
      rewritePrefix: item.rewritePrefix,
      upstream,
      roles: allowed,
      readOnlyRoles: readOnly,
      endpoints,
    });
  }
  if (!routes.length) invalid('enabled routes');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'silent'].includes(logLevel))
    invalid('LOG_LEVEL');
  return {
    production,
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 8080, 1, 65535),
    logLevel,
    secret,
    issuer: required('JWT_ISSUER'),
    authUrl: origin(env.AUTH_SERVICE_URL, 'AUTH_SERVICE_URL'),
    origins,
    trustedProxies,
    redisUrl,
    routes,
    rateMax: integer('RATE_LIMIT_MAX', 120, 1, 100000),
    loginMax: integer('LOGIN_RATE_LIMIT_MAX', 10, 1, 10000),
    windowMs: integer('RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),
    bodyLimit: integer('BODY_LIMIT_BYTES', 1048576, 1, 10485760),
    responseLimit: integer('RESPONSE_LIMIT_BYTES', 10485760, 1, 104857600),
    upstreamTimeout: integer('UPSTREAM_TIMEOUT_MS', 4000, 100, 30000),
    authTimeout: integer('AUTH_TIMEOUT_MS', 2000, 100, 5000),
  };
}
