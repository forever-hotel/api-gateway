import { GatewayError } from './errors.ts';

export async function boundedBody(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new GatewayError(
          502,
          'BAD_GATEWAY',
          'Upstream response exceeded the gateway limit.',
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

export function requestPath(raw: string): { pathname: string; search: string } {
  const [pathname] = raw.split('?');
  // Reject ambiguous/encoded path routing rather than decode twice across hops.
  // Query values may still be percent-encoded and are preserved byte-for-byte.
  if (
    !pathname.startsWith('/') ||
    !/^\/[A-Za-z0-9/_.~-]*$/.test(pathname) ||
    pathname.includes('//') ||
    pathname.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new GatewayError(
      400,
      'VALIDATION_ERROR',
      'Use a canonical, unencoded API path.',
    );
  }
  return { pathname, search: raw.slice(pathname.length) };
}
