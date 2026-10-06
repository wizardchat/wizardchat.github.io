import { createHash, randomBytes } from 'node:crypto';

/** URL-safe random token (32 bytes → 43 chars by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
