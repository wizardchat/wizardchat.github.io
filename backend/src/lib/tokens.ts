import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config.js';

const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

export type AccessTokenRole = 'USER' | 'ADMIN';

export interface AccessTokenPayload {
  sub: string;
  role: AccessTokenRole;
  type: 'access';
}

export async function signAccessToken(userId: string, role: AccessTokenRole): Promise<string> {
  return new SignJWT({ role, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      (payload.role !== 'USER' && payload.role !== 'ADMIN')
    ) {
      return null;
    }
    return { sub: payload.sub, role: payload.role, type: 'access' };
  } catch {
    return null;
  }
}
