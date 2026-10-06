import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { decryptMessage } from '../lib/messageCrypto.js';
import { hashPassword } from '../lib/password.js';
import { randomToken } from '../lib/random.js';
import { requireAdmin } from '../middleware/auth.js';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

export const adminRouter = Router();

adminRouter.use(requireAdmin);

function ioFrom(req: Request): Io | undefined {
  return req.app.get('io') as Io | undefined;
}

const adminUserSelect = {
  id: true,
  username: true,
  email: true,
  role: true,
  banned: true,
  avatarUrl: true,
  createdAt: true,
  _count: {
    select: {
      sentMessages: true,
      sessions: { where: { revokedAt: null } },
    },
  },
} as const;

function serializeAdminUser(
  u: Awaited<ReturnType<typeof prisma.user.findMany<{ select: typeof adminUserSelect }>>>[number],
) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    banned: u.banned,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
    messageCount: u._count.sentMessages,
    activeSessions: u._count.sessions,
  };
}

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

adminRouter.get('/users', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query' });
    return;
  }
  const { q, limit, offset } = parsed.data;
  const where = q
    ? {
        OR: [
          { username: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: adminUserSelect,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ users: users.map(serializeAdminUser), total });
});

adminRouter.get('/users/:id', async (req, res) => {
  const id = req.params.id;
  const user = await prisma.user.findUnique({
    where: { id },
    select: adminUserSelect,
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: serializeAdminUser(user) });
});

const patchSchema = z
  .object({
    banned: z.boolean().optional(),
    role: z.enum(['USER', 'ADMIN']).optional(),
  })
  .refine((v) => v.banned !== undefined || v.role !== undefined, {
    message: 'Nothing to update',
  });

adminRouter.patch('/users/:id', async (req, res) => {
  const id = req.params.id;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id }, select: adminUserSelect });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (req.user && req.user.id === user.id) {
    res.status(400).json({ error: 'You cannot modify your own account' });
    return;
  }

  const data: { banned?: boolean; role?: 'USER' | 'ADMIN' } = {};
  if (parsed.data.banned !== undefined) data.banned = parsed.data.banned;
  if (parsed.data.role !== undefined) data.role = parsed.data.role;

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: adminUserSelect,
  });

  if (Object.keys(data).length > 0) {
    ioFrom(req)?.to(`user:${id}`).emit('account:updated', {
      userId: id,
      ...(data.banned !== undefined ? { banned: data.banned } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
    });
  }

  console.warn(
    `[admin] ${req.user?.username ?? 'unknown'} updated ${updated.username}: ${Object.keys(data).join(', ')}`,
  );

  res.json({ ok: true, user: serializeAdminUser(updated) });
});

adminRouter.delete('/users/:id', async (req, res) => {
  const id = req.params.id;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (req.user && req.user.id === user.id) {
    res.status(400).json({ error: 'You cannot delete your own account' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const memberships = await tx.chatMember.findMany({
      where: { userId: id },
      select: { chatId: true },
    });
    for (const m of memberships) {
      const chat = await tx.chat.findUnique({
        where: { id: m.chatId },
        select: { type: true },
      });
      if (!chat) continue;
      const memberCount = await tx.chatMember.count({ where: { chatId: m.chatId } });
      if (memberCount <= 1 || (chat.type === 'DIRECT' && memberCount <= 2)) {
        await tx.chat.delete({ where: { id: m.chatId } });
      }
    }
    await tx.user.delete({ where: { id } });
  });

  ioFrom(req)?.to(`user:${id}`).emit('account:deleted', { userId: id });

  console.warn(`[admin] ${req.user?.username ?? 'unknown'} deleted user ${user.username}`);

  res.json({ ok: true, deletedUser: { id, username: user.username } });
});

const messagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

adminRouter.get('/users/:id/messages', async (req, res) => {
  const id = req.params.id;
  const parsed = messagesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const messages = await prisma.message.findMany({
    where: { senderId: id },
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit,
    select: { id: true, chatId: true, ciphertext: true, nonce: true, isE2ee: true, createdAt: true },
  });
  res.json({
    messages: messages.map((m) => {
      let preview: string | null = null;
      if (!m.isE2ee) {
        try {
          preview = decryptMessage({ ciphertext: m.ciphertext, nonce: m.nonce }).slice(0, 160);
        } catch {
          preview = null;
        }
      }
      return { id: m.id, chatId: m.chatId, isE2ee: m.isE2ee, preview, createdAt: m.createdAt };
    }),
  });
});

adminRouter.delete('/users/:id/messages/:messageId', async (req, res) => {
  const userId = req.params.id;
  const messageId = req.params.messageId;
  const message = await prisma.message.findFirst({
    where: { id: messageId, senderId: userId },
    select: { id: true, chatId: true },
  });
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  await prisma.message.delete({ where: { id: message.id } });
  ioFrom(req)?.to(`chat:${message.chatId}`).emit('messages:deleted', {
    chatId: message.chatId,
    messageIds: [message.id],
  });
  res.json({ ok: true });
});

adminRouter.delete('/users/:id/messages', async (req, res) => {
  const userId = req.params.id;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const messages = await prisma.message.findMany({
    where: { senderId: userId },
    select: { id: true, chatId: true },
  });
  if (messages.length > 0) {
    await prisma.message.deleteMany({ where: { senderId: userId } });
    const byChat = new Map<string, string[]>();
    for (const m of messages) {
      const arr = byChat.get(m.chatId) ?? [];
      arr.push(m.id);
      byChat.set(m.chatId, arr);
    }
    const io = ioFrom(req);
    for (const [chatId, messageIds] of byChat) {
      io?.to(`chat:${chatId}`).emit('messages:deleted', { chatId, messageIds });
    }
  }
  res.json({ ok: true, deleted: messages.length });
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const targetId = req.params.id;
  const admin = req.user;

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

  ioFrom(req)?.to(`user:${user.id}`).emit('account:locked', { userId: user.id });

  console.warn(`[admin] ${admin?.username ?? 'unknown'} reset password for ${user.username}`);

  res.json({ ok: true, username: user.username, tempPassword });
});