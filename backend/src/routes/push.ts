import { Router } from 'express';
import { z } from 'zod';
import { pushEnabled, vapidConfig } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const pushRouter = Router();

/** Public VAPID key so browsers can subscribe; null when push is disabled. */
pushRouter.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: pushEnabled && vapidConfig ? vapidConfig.publicKey : null });
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

pushRouter.post('/subscribe', requireAuth, async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid subscription' });
    return;
  }
  const { endpoint, keys } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: me.id, endpoint, keysP256dh: keys.p256dh, keysAuth: keys.auth },
    update: { userId: me.id, keysP256dh: keys.p256dh, keysAuth: keys.auth },
  });
  res.json({ ok: true });
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1024) });

pushRouter.delete('/subscribe', requireAuth, async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const parsed = unsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid subscription' });
    return;
  }
  try {
    await prisma.pushSubscription.delete({
      where: { endpoint: parsed.data.endpoint },
    });
  } catch {
    // Already removed.
  }
  res.json({ ok: true });
});