import { Module, type DynamicModule } from '@nestjs/common';
import type { Config } from './config.ts';
import { GATEWAY_CONFIG, GatewayTransport } from './gateway.transport.ts';

@Module({})
export class GatewayModule {
  static register(config: Config): DynamicModule {
    return {
      module: GatewayModule,
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        GatewayTransport,
      ],
      exports: [GatewayTransport],
    };
  }
}
