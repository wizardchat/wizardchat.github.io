import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config.js';

const KEY = Buffer.from(env.MESSAGE_ENCRYPTION_KEY, 'hex');

if (KEY.length !== 32) {
  throw new Error('MESSAGE_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedPayload {
  /** base64(iv || ciphertext || gcm-tag) */
  ciphertext: string;
  /** base64(12-byte IV) */
  nonce: string;
}

export function encryptMessage(plaintext: string): EncryptedPayload {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

export function decryptMessage(payload: EncryptedPayload): string {
  const nonce = Buffer.from(payload.nonce, 'base64');
  const data = Buffer.from(payload.ciphertext, 'base64');
  if (nonce.length !== NONCE_BYTES || data.length <= TAG_BYTES) {
    throw new Error('Malformed encrypted payload');
  }
  const tag = data.subarray(data.length - TAG_BYTES);
  const encrypted = data.subarray(0, data.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', KEY, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
