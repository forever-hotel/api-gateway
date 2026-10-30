import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { GatewayModule } from './gateway.module.ts';
import { GatewayTransport } from './gateway.transport.ts';
import { GatewayAdapter } from './gateway.adapter.ts';

export async function buildApp(config: Config, logging = true) {
  const adapter = new GatewayAdapter({
    logger: logging ? { level: config.logLevel } : false,
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: config.bodyLimit,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    forceCloseConnections: 'idle'
  });
  const app = await NestFactory.create<NestFastifyApplication>(GatewayModule.register(config), adapter, {
    bodyParser: false,
    logger: false,
    abortOnError: false
  });

  try {
    await app.init();
    await app.get(GatewayTransport).configure();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
