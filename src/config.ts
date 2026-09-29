import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export interface Route {
  id: string;
  prefix: string;
  rewritePrefix: string;
  upstream: string;
}
export interface Config {
  production: boolean;
  host: string;
  port: number;
  logLevel: string;
  origins: string[];
  trustedProxies: string[];
  redisUrl?: string;
  rateMax: number;
  loginMax: number;
  windowMs: number;
  bodyLimit: number;
  responseLimit: number;
  upstreamTimeout: number;
  healthTimeout: number;
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
  const routes: Route[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean')
      invalid('route enabled');
    if (
      Object.keys(item).some(
        (key) =>
          !['id', 'enabled', 'prefix', 'rewritePrefix', 'upstreamEnv'].includes(
            key,
          ),
      )
    )
      invalid('route fields (only routing configuration is supported)');
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
        (route) => route.id === item.id || route.prefix === item.prefix,
      )
    )
      invalid('duplicate route id/prefix');
    if (
      typeof item.upstreamEnv !== 'string' ||
      !/^[A-Z_]+$/.test(item.upstreamEnv)
    )
      invalid('route upstreamEnv');
    const upstream = origin(env[item.upstreamEnv], item.upstreamEnv);
    routes.push({
      id: item.id,
      prefix: item.prefix,
      rewritePrefix: item.rewritePrefix,
      upstream,
    });
  }
  if (!routes.length) invalid('enabled routes');
  // A subsystem's more specific /mad/auth mapping wins over /mad.
  routes.sort((a, b) => b.prefix.length - a.prefix.length);
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'silent'].includes(logLevel))
    invalid('LOG_LEVEL');
  return {
    production,
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 8080, 1, 65535),
    logLevel,
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
    healthTimeout: integer('HEALTH_TIMEOUT_MS', 2000, 100, 5000),
  };
}
