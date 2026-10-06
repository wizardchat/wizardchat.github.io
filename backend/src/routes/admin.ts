import { Router } from 'express';
import { prisma } from '../db.js';
import { hashPassword } from '../lib/password.js';
import { randomToken } from '../lib/random.js';
import { requireAdmin } from '../middleware/auth.js';

export const adminRouter = Router();

adminRouter.use(requireAdmin);

/**
 * Admin password reset: returns a one-time temp password, revokes every
 * session of the target user, and clears their E2EE key bundle so a fresh
 * keypair is generated on their next login (old DM history becomes
 * undecryptable — intentional after a suspected compromise).
 */
adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const targetId = typeof req.params.id === 'string' ? req.params.id : null;
  const admin = req.user;

  if (!targetId) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: targetId } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (admin?.id === user.id) {
    res.status(400).json({ error: 'You cannot reset your own password' });
    return;
  }

  const tempPassword = `Temp-${randomToken(16)}`;
  const passwordHash = await hashPassword(tempPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        e2ePublicKey: null,
        e2eWrappedKey: null,
        e2eKekSalt: null,
        e2eKekParams: null,
        e2eKeysUpdatedAt: null,
      },
    }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'admin_reset' },
    }),
  ]);

  console.warn(`[admin] ${admin?.username ?? 'unknown'} reset password for ${user.username}`);

  res.json({ ok: true, username: user.username, tempPassword });
});
