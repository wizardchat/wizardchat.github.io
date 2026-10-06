import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: 'USER' | 'ADMIN';
  banned: boolean;
  avatarUrl: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const payload = await verifyAccessToken(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Re-read the user on every request so bans take effect immediately.
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true, email: true, role: true, banned: true, avatarUrl: true },
  });

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (user.banned) {
    res.status(403).json({ error: 'Account suspended' });
    return;
  }

  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });
}
