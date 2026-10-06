import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { env, REFRESH_COOKIE_NAME } from '../config.js';
import { prisma } from '../db.js';
import { clearRefreshCookie, setRefreshCookie } from '../lib/cookies.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/password.js';
import { randomToken, sha256hex } from '../lib/random.js';
import { signAccessToken } from '../lib/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';

export const authRouter = Router();

const publicUserSelect = {
  id: true,
  username: true,
  email: true,
  role: true,
  banned: true,
  avatarUrl: true,
  createdAt: true,
} as const;

const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
  email: z.union([z.literal(''), z.email().max(254)]).optional(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

async function issueSession(userId: string, meta: SessionMeta) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256hex(token),
      csrfTokenHash: sha256hex(csrfToken),
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip ?? null,
      expiresAt,
    },
  });

  return { token, csrfToken };
}

function clientMeta(req: Request): SessionMeta {
  return {
    userAgent: req.get('user-agent') ?? undefined,
    ip: req.ip,
  };
}

authRouter.post('/register', authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const username = parsed.data.username.toLowerCase();
  const emailRaw = parsed.data.email?.trim();
  const email = emailRaw ? emailRaw.toLowerCase() : null;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, ...(email ? [{ email }] : [])] },
    select: { id: true },
  });
  if (existing) {
    res.status(409).json({ error: 'Username or email already taken' });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: { username, email, passwordHash },
    select: publicUserSelect,
  });

  const { token, csrfToken } = await issueSession(user.id, clientMeta(req));
  setRefreshCookie(res, token);
  const accessToken = await signAccessToken(user.id, user.role);

  res.status(201).json({ user, accessToken, csrfToken });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }

  const identifier = parsed.data.identifier.toLowerCase();
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { username: identifier }] },
  });

  if (!user) {
    // Equalize timing with a real password check.
    await verifyAgainstDummy(parsed.data.password);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (user.banned) {
    res.status(403).json({ error: 'Account suspended' });
    return;
  }

  const { token, csrfToken } = await issueSession(user.id, clientMeta(req));
  setRefreshCookie(res, token);
  const accessToken = await signAccessToken(user.id, user.role);

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      banned: user.banned,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    },
    accessToken,
    csrfToken,
  });
});

authRouter.post('/refresh', async (req, res) => {
  const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME];
  const csrfHeader = req.get('x-csrf-token');

  if (typeof cookieToken !== 'string' || !csrfHeader) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const tokenHash = sha256hex(cookieToken);
  const session = await prisma.session.findFirst({
    where: { OR: [{ tokenHash }, { prevTokenHash: tokenHash }] },
    include: { user: { select: publicUserSelect } },
  });

  if (!session) {
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // A rotated token presented again → likely theft. Revoke every session.
  if (session.prevTokenHash === tokenHash) {
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'token_reuse' },
    });
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Session revoked' });
    return;
  }

  if (session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (sha256hex(csrfHeader) !== session.csrfTokenHash) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }

  if (session.user.banned) {
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'banned' },
    });
    clearRefreshCookie(res);
    res.status(403).json({ error: 'Account suspended' });
    return;
  }

  // Rotate: current token becomes the previous one (for reuse detection).
  const newToken = randomToken();
  const newCsrf = randomToken(24);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.update({
    where: { id: session.id },
    data: {
      prevTokenHash: session.tokenHash,
      tokenHash: sha256hex(newToken),
      csrfTokenHash: sha256hex(newCsrf),
      expiresAt,
      lastUsedAt: new Date(),
    },
  });

  setRefreshCookie(res, newToken);
  const accessToken = await signAccessToken(session.user.id, session.user.role);
  res.json({ user: session.user, accessToken, csrfToken: newCsrf });
});

authRouter.post('/logout', async (req, res) => {
  const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof cookieToken === 'string') {
    await prisma.session.updateMany({
      where: { tokenHash: sha256hex(cookieToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const valid = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
  if (!valid) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke every other session; keep the current one if we can identify it.
  const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME];
  const currentHash = typeof cookieToken === 'string' ? sha256hex(cookieToken) : null;
  await prisma.session.updateMany({
    where: {
      userId: user.id,
      revokedAt: null,
      ...(currentHash ? { NOT: { tokenHash: currentHash } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: 'password_change' },
  });

  res.json({ ok: true });
});
