import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
test('only configured WebSocket routes proxy upgrades, origins and persistent tunnel bytes', async t => {
  let upstreamPath = '';
  const upstream = createServer((_request, response) => {
    response.end('{}');
  });
  upstream.on('upgrade', (request, socket) => {
    upstreamPath = request.url ?? '';
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\n\r\n'
    );
    socket.on('data', chunk => socket.write(chunk));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error();
  const config = loadConfig(
    { NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:3000', WS_URL: `http://127.0.0.1:${address.port}` },
    [{ id: 'shared', enabled: true, prefix: '/realtime', rewritePrefix: '', upstreamEnv: 'WS_URL', websocket: true }]
  );
  const app = await buildApp(config, false);
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const port = new URL(await app.getUrl()).port;
  async function upgrade(path: string, origin: string, echo = false) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1');
      let result = '';
      let sent = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Upgrade timeout'));
      }, 5000);
      socket.on('connect', () =>
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
        )
      );
      socket.on('data', chunk => {
        result += chunk.toString();
        if (!echo || result.includes('tunnel-data')) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(result);
        } else if (!sent && result.includes('\r\n\r\n')) {
          sent = true;
          socket.write('tunnel-data');
        }
      });
      socket.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
  assert.match(
    await upgrade('/realtime/socket.io/?EIO=4&transport=websocket', 'http://localhost:3000', true),
    /101 Switching Protocols[\s\S]*tunnel-data/
  );
  assert.equal(upstreamPath, '/socket.io/?EIO=4&transport=websocket');
  assert.match(await upgrade('/realtime/socket.io/', 'http://attacker.invalid'), /403/);
  assert.match(await upgrade('/mad/socket.io/', 'http://localhost:3000'), /404/);
});
