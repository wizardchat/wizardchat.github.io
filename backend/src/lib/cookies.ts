import type { Response } from 'express';
import { env, isProduction, REFRESH_COOKIE_NAME } from '../config.js';

const cookieBase = {
  httpOnly: true,
  secure: isProduction,
  // Dev: localhost:5173 → localhost:3000 is same-site, so Lax works.
  // Prod: frontend (github.io) and API (onrender.com) are cross-site → None required.
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  // Restrict the cookie to auth endpoints only.
  path: '/auth',
} as const;

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...cookieBase,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieBase);
}
