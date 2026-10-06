import { Router } from 'express';
import { z } from 'zod';
import { attachmentUrlAllowed } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const usersRouter = Router();

const searchSchema = z.object({
  q: z.string().trim().min(1).max(32),
});

usersRouter.get('/search', requireAuth, async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query' });
    return;
  }

  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const users = await prisma.user.findMany({
    where: {
      username: { startsWith: parsed.data.q.toLowerCase() },
      id: { not: me.id },
      banned: false,
    },
    select: { id: true, username: true, e2ePublicKey: true, avatarUrl: true },
    orderBy: { username: 'asc' },
    take: 10,
  });

  res.json({ users });
});

const avatarSchema = z.object({
  avatarUrl: z.union([
    z.null(),
    z
      .string()
      .trim()
      .max(1024)
      .refine((value) => attachmentUrlAllowed(value), 'URL is not allowed'),
  ]),
});

usersRouter.put('/me/avatar', requireAuth, async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = avatarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid avatarUrl' });
    return;
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: { avatarUrl: parsed.data.avatarUrl },
  });

  res.json({ ok: true, avatarUrl: parsed.data.avatarUrl });
});

function isCanonicalBase64(value: string, decodedLength: number): boolean {
  const buf = Buffer.from(value, 'base64');
  return buf.length === decodedLength && buf.toString('base64') === value;
}

const e2eKeySchema = z.object({
  publicKey: z.string().refine((v) => isCanonicalBase64(v, 32), 'publicKey must be base64 of 32 bytes'),
  wrappedKey: z.string().refine((v) => {
    const buf = Buffer.from(v, 'base64');
    return buf.length >= 28 && buf.length <= 64 && buf.toString('base64') === v;
  }, 'wrappedKey must be base64 of 28-64 bytes'),
  kekSalt: z.string().refine((v) => isCanonicalBase64(v, 16), 'kekSalt must be base64 of 16 bytes'),
  kekParams: z
    .string()
    .max(256)
    .refine((v) => {
      try {
        const params = JSON.parse(v) as { alg?: unknown; hash?: unknown; iterations?: unknown };
        return (
          params.alg === 'PBKDF2' &&
          params.hash === 'SHA-256' &&
          Number.isInteger(params.iterations) &&
          (params.iterations as number) >= 100_000 &&
          (params.iterations as number) <= 2_000_000
        );
      } catch {
        return false;
      }
    }, 'kekParams must be {alg:"PBKDF2",hash:"SHA-256",iterations}'),
});

usersRouter.get('/me/e2e-key', requireAuth, async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      e2ePublicKey: true,
      e2eWrappedKey: true,
      e2eKekSalt: true,
      e2eKekParams: true,
      e2eKeysUpdatedAt: true,
    },
  });
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  res.json({
    publicKey: user.e2ePublicKey,
    wrappedKey: user.e2eWrappedKey,
    kekSalt: user.e2eKekSalt,
    kekParams: user.e2eKekParams,
    updatedAt: user.e2eKeysUpdatedAt?.toISOString() ?? null,
  });
});

usersRouter.put('/me/e2e-key', requireAuth, async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = e2eKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid key bundle', details: parsed.error.issues });
    return;
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      e2ePublicKey: parsed.data.publicKey,
      e2eWrappedKey: parsed.data.wrappedKey,
      e2eKekSalt: parsed.data.kekSalt,
      e2eKekParams: parsed.data.kekParams,
      e2eKeysUpdatedAt: new Date(),
    },
  });

  res.json({ ok: true });
});

usersRouter.get('/:id/e2e-key', requireAuth, async (req, res) => {
  const userId = typeof req.params.id === 'string' ? req.params.id : null;
  if (!userId) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { e2ePublicKey: true, banned: true },
  });
  if (!user || user.banned) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({ publicKey: user.e2ePublicKey });
});
