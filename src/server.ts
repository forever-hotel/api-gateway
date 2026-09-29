import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    await app.close();
    clearTimeout(deadline);
  };
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
  await app.listen({ host: config.host, port: config.port });
}
main().catch((error: unknown) => {
  // Startup exceptions can contain private upstream URLs.
  console.error(
    error instanceof Error && error.message.startsWith('Configuration:')
      ? error.message
      : 'Gateway startup failed. Check configuration and port availability.',
  );
  process.exitCode = 1;
});
