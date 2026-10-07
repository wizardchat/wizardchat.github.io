import 'dotenv/config';
import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ACCESS_TOKEN_SECRET: isProd
    ? z.string().min(32)
    : z.string().min(32).default('dev-access-secret-do-not-use-in-production'),
  REFRESH_TOKEN_SECRET: isProd
    ? z.string().min(32)
    : z.string().min(32).default('dev-refresh-secret-do-not-use-in-production'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // 32-byte key as 64 hex chars — encrypts message content at rest (AES-256-GCM).
  MESSAGE_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
    .default('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'),
  // cloudinary://API_KEY:API_SECRET@CLOUD_NAME — enables signed file uploads.
  CLOUDINARY_URL: z.string().optional(),
  // Host allowlist for attachment/avatar URLs. Enforced only in production.
  ALLOWED_ATTACHMENT_HOSTS: z.string().default('res.cloudinary.com'),
  // Web Push VAPID keys (https://web-push lib). Optional — push is disabled when absent.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

export const env = envSchema.parse(process.env);

/**
 * Render commonly ships empty-string env vars (a key is present but blank).
 * zod's `.default()` only applies to *missing* keys, so a blank allowlist would
 * silently become [] and reject every attachment. Treat blank as unset.
 */
export const allowedAttachmentHosts =
  typeof env.ALLOWED_ATTACHMENT_HOSTS === 'string' &&
  env.ALLOWED_ATTACHMENT_HOSTS.trim() !== ''
    ? env.ALLOWED_ATTACHMENT_HOSTS
    : 'res.cloudinary.com';

export const isProduction = env.NODE_ENV === 'production';

export const corsOrigins: string[] = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export const cloudinaryConfig: CloudinaryConfig | null = (() => {
  const raw = env.CLOUDINARY_URL;
  if (!raw) return null;
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@([^/]+)$/.exec(raw);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error('CLOUDINARY_URL must look like cloudinary://API_KEY:API_SECRET@CLOUD_NAME');
  }
  return { apiKey: match[1], apiSecret: match[2], cloudName: match[3] };
})();

/**
 * Attachment/avatar URLs must be HTTPS. In production they must additionally
 * belong to an allowlisted host (default: res.cloudinary.com).
 */
export function attachmentUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (!isProduction) return true;
  const normalizeHost = (raw: string): string =>
    raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/:]/)[0] ?? '';
  const allowed = allowedAttachmentHosts.split(',').map(normalizeHost).filter((host) => host !== '');
  return allowed.includes(parsed.hostname.toLowerCase());
}

export const REFRESH_COOKIE_NAME = 'wc_rt';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const nonEmpty = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export const vapidConfig: VapidConfig | null = (() => {
  const publicKey = nonEmpty(env.VAPID_PUBLIC_KEY);
  const privateKey = nonEmpty(env.VAPID_PRIVATE_KEY);
  const subject = nonEmpty(env.VAPID_SUBJECT) ?? 'mailto:admin@wizardchat.app';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
})();

export const pushEnabled = vapidConfig !== null;
