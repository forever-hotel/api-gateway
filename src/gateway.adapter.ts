import { FastifyAdapter } from '@nestjs/platform-fastify';

// The transport owns the existing error envelopes and fallback routes.
// Prevent Nest's default handlers from occupying Fastify's fallback handler.
export class GatewayAdapter extends FastifyAdapter {
  override setNotFoundHandler() {
    return this.getInstance();
  }

  override setErrorHandler() {
    return this.getInstance();
  }
}
