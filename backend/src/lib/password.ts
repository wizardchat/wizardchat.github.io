import { Algorithm, hash, verify } from '@node-rs/argon2';

// OWASP recommended Argon2id parameters (memory in KiB).
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * Verifies against a throwaway hash so that login attempts for unknown
 * accounts take roughly the same time as real ones (timing-attack resistance).
 */
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-equalization');
  return dummyHashPromise.then((dummy) => verifyPassword(dummy, password));
}
