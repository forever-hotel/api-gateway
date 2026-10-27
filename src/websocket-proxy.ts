import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import { requestPath } from './http.ts';
// Fixed configured upstreams only; the gateway never validates subsystem JWTs.
export function websocketProxy(app: FastifyInstance, config: Config) {
  const tunnels = new Set<Duplex>();
  const attempts = new Map<string, { count: number; expires: number }>();
  app.server.on('upgrade', (request, socket, head) => {
    const reject = (status: number) =>
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      if (
        request.method !== 'GET' ||
        !request.headers.origin ||
        !config.origins.includes(request.headers.origin) ||
        request.headers.upgrade?.toLowerCase() !== 'websocket'
      )
        return void reject(403);
      const { pathname, search } = requestPath(request.url ?? '/');
      const route = config.routes.find(item => pathname === item.prefix || pathname.startsWith(item.prefix + '/'));
      if (!route?.websocket) return void reject(404);
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.expires <= now) attempts.delete(key);
      const ip = request.socket.remoteAddress ?? '';
      const entry = attempts.get(ip) ?? { count: 0, expires: now + config.windowMs };
      if (++entry.count > config.rateMax || attempts.size > 10000) return void reject(429);
      attempts.set(ip, entry);
      const target = new URL(route.rewritePrefix + pathname.slice(route.prefix.length) + search, route.upstream);
      const headers: Record<string, string> = {
        host: target.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin: request.headers.origin
      };
      for (const name of [
        'sec-websocket-key',
        'sec-websocket-version',
        'sec-websocket-protocol',
        'sec-websocket-extensions'
      ]) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'GET', headers });
      const timeout = setTimeout(() => {
        upstream.destroy();
        reject(504);
      }, config.upstreamTimeout);
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => {
        clearTimeout(timeout);
        upstream.destroy();
        tunnels.delete(socket);
      });
      upstream.on('upgrade', (response, remote, remoteHead) => {
        clearTimeout(timeout);
        request.socket.setTimeout(0);
        remote.setTimeout(0);
        if (socket.destroyed) {
          remote.destroy();
          return;
        }
        tunnels.add(socket);
        tunnels.add(remote);
        let result = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
        for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          const value = response.headers[name];
          if (typeof value === 'string') result += `${name}: ${value}\r\n`;
        }
        socket.write(result + '\r\n');
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        remote.on('error', () => socket.destroy());
        remote.on('close', () => {
          tunnels.delete(remote);
          socket.destroy();
        });
        socket.on('close', () => remote.destroy());
        socket.pipe(remote).pipe(socket);
      });
      upstream.on('response', response => {
        clearTimeout(timeout);
        response.destroy();
        reject(response.statusCode ?? 502);
      });
      upstream.on('error', () => {
        clearTimeout(timeout);
        if (!socket.destroyed) reject(503);
      });
      upstream.end();
    } catch {
      reject(400);
    }
  });
  app.addHook('preClose', async () => {
    for (const socket of tunnels) socket.destroy();
    tunnels.clear();
  });
}
