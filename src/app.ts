import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { METHODS } from './config.ts';
import { boundedBody, requestPath } from './http.ts';
import { GatewayError, forbidden, unavailable } from './errors.ts';

const messages: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', 'The request is invalid.'],
  401: ['UNAUTHENTICATED', 'Please sign in again.'],
  403: ['FORBIDDEN', 'You do not have permission for this request.'],
  404: ['NOT_FOUND', 'The endpoint was not found.'],
  405: ['METHOD_NOT_ALLOWED', 'The method is not allowed.'],
  409: ['CONFLICT', 'The request conflicts with the current state.'],
  413: ['PAYLOAD_TOO_LARGE', 'The request exceeds the size limit.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'The media type is unsupported.'],
  422: ['VALIDATION_ERROR', 'The request is invalid.'],
  429: ['RATE_LIMITED', 'Too many requests. Please retry later.'],
  502: ['BAD_GATEWAY', 'The upstream service returned an invalid response.'],
  503: [
    'SERVICE_UNAVAILABLE',
    'Service temporarily unavailable. Please retry.',
  ],
  504: ['GATEWAY_TIMEOUT', 'The upstream service did not respond in time.'],
};
export async function buildApp(config: Config, logging = true) {
  const app = Fastify({
    logger: logging ? { level: config.logLevel } : false,
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: config.bodyLimit,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    forceCloseConnections: 'idle',
  });
  let redis: Redis | undefined;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => app.log.warn({ event: 'rate_store_unavailable' }));
    try {
      await redis.connect();
    } catch {
      redis.disconnect();
      throw new Error('Rate-limit store unavailable');
    }
    app.addHook('onClose', async () => {
      redis?.disconnect();
    });
  }
  app.setErrorHandler(
    (error: Error & { statusCode?: number; code?: string }, request, reply) => {
      const status =
        error instanceof GatewayError
          ? error.status
          : error.statusCode && messages[error.statusCode]
            ? error.statusCode
            : 503;
      const [code, message] = messages[status] ?? messages[503];
      reply.code(status).send({
        code: error instanceof GatewayError ? error.code : code,
        message: error instanceof GatewayError ? error.message : message,
        requestId: request.id,
      });
    },
  );
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('x-request-id', request.id)
      .header('cache-control', 'no-store');
    requestPath(request.raw.url ?? '/');
    if (
      request.headers.origin &&
      !config.origins.includes(request.headers.origin)
    )
      throw forbidden();
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.origins,
    credentials: false,
    methods: [...METHODS],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'If-None-Match',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: false,
    max: (request) =>
      request.url.split('?')[0].endsWith('/login')
        ? config.loginMax
        : config.rateMax,
    timeWindow: config.windowMs,
    redis,
    skipOnError: false,
    nameSpace: 'forever-gateway:',
    errorResponseBuilder: (request) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please retry later.',
      requestId: request.id,
    }),
  });
  // Transport limits apply independently of downstream authentication decisions.
  app.addHook('onRequest', app.rateLimit());
  app.addHook('onResponse', async (request, reply) => {
    // No URLs, queries, headers, usernames, bodies or JWTs enter the access log.
    const pathname = request.url.split('?')[0];
    const route = config.routes.find(
      (candidate) =>
        pathname === candidate.prefix ||
        pathname.startsWith(candidate.prefix + '/'),
    );
    app.log.info({
      event: 'request_complete',
      requestId: request.id,
      route: route?.id ?? 'gateway',
      method: request.method,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });
  // Preserve exact bytes for downstream signature/body validation; bounded by Fastify.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  app.get('/health/live', async () => ({
    status: 'ok',
    service: 'forever-hotel-api-gateway',
  }));
  app.get('/health/ready', async () => {
    if (redis && redis.status !== 'ready') throw unavailable();
    const upstreams = [
      ...new Set(config.routes.map((route) => route.upstream)),
    ];
    const checks = await Promise.all(
      upstreams.map(async (upstream) => {
        try {
          const response = await fetch(upstream + '/health/ready', {
            redirect: 'manual',
            signal: AbortSignal.timeout(config.healthTimeout),
          });
          await response.body?.cancel();
          return response.ok;
        } catch {
          return false;
        }
      }),
    );
    if (checks.some((ok) => !ok)) throw unavailable();
    return {
      status: 'ok',
      service: 'forever-hotel-api-gateway',
      upstreams: 'ready',
    };
  });
  app.route({
    method: [...METHODS],
    url: '/*',
    // Reject unknown destinations before buffering the body.
    onRequest: async (request) => {
      const { pathname } = requestPath(request.raw.url ?? '/');
      const route = config.routes.find(
        (candidate) =>
          pathname === candidate.prefix ||
          pathname.startsWith(candidate.prefix + '/'),
      );
      if (!route) throw new GatewayError(404, 'NOT_FOUND', messages[404][1]);
      contexts.set(request, route);
    },
    handler: async (request, reply) => {
      const route = contexts.get(request)!;
      const { pathname, search } = requestPath(request.raw.url ?? '/');
      const target =
        route.upstream +
        route.rewritePrefix +
        pathname.slice(route.prefix.length) +
        search;
      const headers = new Headers();
      for (const name of [
        'accept',
        'content-type',
        'idempotency-key',
        'if-match',
        'if-none-match',
        'stripe-signature',
        'authorization',
      ]) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      headers.set('x-request-id', request.id);
      headers.set('x-forwarded-for', request.ip);
      // Authorization is opaque: only the destination service may validate it.
      // Client-supplied identity headers and cookies are never trusted/forwarded.
      let response: Response;
      let body: Buffer;
      const signal = AbortSignal.timeout(config.upstreamTimeout);
      const abort = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once('close', onClose);
      try {
        response = await fetch(target, {
          method: request.method,
          headers,
          ...(request.body instanceof Buffer &&
          !['GET', 'HEAD'].includes(request.method)
            ? { body: new Uint8Array(request.body) }
            : {}),
          redirect: 'manual',
          signal: AbortSignal.any([signal, abort.signal]),
        });
        body = await boundedBody(response, config.responseLimit);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (signal.aborted)
          throw new GatewayError(504, 'GATEWAY_TIMEOUT', messages[504][1]);
        throw unavailable();
      } finally {
        reply.raw.off('close', onClose);
      }
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304
      )
        throw new GatewayError(502, 'BAD_GATEWAY', messages[502][1]);
      if (response.status >= 500) throw unavailable();
      const retry = response.headers.get('retry-after');
      if (response.status === 429 && retry && /^\d{1,6}$/.test(retry))
        reply.header('retry-after', retry);
      // Preserve subsystem login/session/validation errors, including 401/403.
      for (const name of [
        'content-type',
        'etag',
        'content-disposition',
        'www-authenticate',
      ]) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      return reply
        .code(response.status)
        .send(
          ['HEAD'].includes(request.method) ||
            [204, 304].includes(response.status)
            ? undefined
            : body,
        );
    },
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 'NOT_FOUND',
      message: messages[404][1],
      requestId: request.id,
    }),
  );
  // This finite-response REST proxy does not implement WebSocket/CONNECT tunnels.
  app.server.on('upgrade', (_request, socket) =>
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'),
  );
  app.server.on('connect', (_request, socket) =>
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'),
  );
  return app;
}

import type { FastifyRequest } from 'fastify';
import type { Route } from './config.ts';
const contexts = new WeakMap<FastifyRequest, Route>();
