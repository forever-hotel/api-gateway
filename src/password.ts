import { compare, hash } from 'bcryptjs';
import { scrypt, timingSafeEqual } from 'node:crypto';

// Legacy scrypt verification profile: N=2^15, r=8, p=3 (32 MiB).
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function validPassword(password: string) {
  return password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72 && /\S/.test(password);
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

export async function verifyPassword(password: string, encoded?: string) {
  if (encoded && /^\$2[aby]\$(?:1[2-6])\$[./A-Za-z0-9]{53}$/.test(encoded))
    return Buffer.byteLength(password, 'utf8') <= 72 && compare(password, encoded);
  const parts = encoded?.split('$') ?? [];
  const valid =
    parts.length === 6 &&
    parts.slice(0, 4).join('$') === 'scrypt$32768$8$3' &&
    /^[a-f0-9]{32}$/.test(parts[4]) &&
    /^[a-f0-9]{128}$/.test(parts[5]);
  // Unknown accounts still pay the same password-hashing cost.
  const actual = await derive(password, valid ? parts[4] : '0'.repeat(32));
  const expected = valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64);

  return timingSafeEqual(actual, expected) && valid;
}
