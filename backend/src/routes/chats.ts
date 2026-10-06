import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import {
  chatMemberShape,
  chatSummary,
  directDisplayName,
  getChatWithMembership,
  lastMessagePreview,
  MAX_MESSAGE_LENGTH,
  memberRole,
  otherMembers,
  serializeMessage,
  type ChatWithMembers,
  type SerializedChatMember,
} from '../lib/chat.js';
import { attachmentUrlAllowed } from '../config.js';
import { requireAuth } from '../middleware/auth.js';

export const chatsRouter = Router();

chatsRouter.use(requireAuth);

const memberInclude = {
  members: {
    include: {
      user: {
        select: {
          id: true,
          username: true,
          banned: true,
          e2ePublicKey: true,
          avatarUrl: true,
        },
      },
    },
  },
} as const;

const messageInclude = {
  sender: { select: { id: true, username: true } },
} as const;

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

function ioFrom(req: Request): Io | undefined {
  return req.app.get('io') as Io | undefined;
}

export const MAX_GROUP_NAME = 50;
export const MAX_GROUP_MEMBERS = 100;

chatsRouter.get('/', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const memberships = await prisma.chatMember.findMany({
    where: { userId: me.id },
    include: {
      chat: {
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  banned: true,
                  e2ePublicKey: true,
                  avatarUrl: true,
                },
              },
            },
          },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, include: messageInclude },
        },
      },
    },
    orderBy: { chat: { updatedAt: 'desc' } },
  });

    const chats = await Promise.all(
      memberships.map(async (membership) => {
        const chat = membership.chat;
        const lastMessage = chat.messages[0] ?? null;
        const serializedLast = lastMessage ? serializeMessage(lastMessage) : null;
        const unreadCount = await prisma.message.count({
          where: {
            chatId: chat.id,
            senderId: { not: me.id },
            createdAt: { gt: membership.lastReadAt },
          },
        });

        return {
          id: chat.id,
          type: chat.type,
          name: directDisplayName(chat, me.id),
          avatarUrl: chat.avatarUrl,
          updatedAt: chat.updatedAt.toISOString(),
          members: chat.members.map(chatMemberShape),
          myRole: memberRole(chat, me.id),
          lastMessage: serializedLast ? lastMessagePreview(serializedLast) : null,
          unreadCount,
        };
      }),
    );

  res.json({ chats });
});

chatsRouter.get('/:id', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  res.json({ chat: chatSummary(chat, me.id) });
});

const createDirectSchema = z.union([
  z.object({ userId: z.string().min(1).max(64) }),
  z.object({ username: z.string().trim().min(1).max(32) }),
]);

chatsRouter.post('/direct', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = createDirectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide userId or username' });
    return;
  }

  const target =
    'userId' in parsed.data
      ? await prisma.user.findUnique({ where: { id: parsed.data.userId } })
      : await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });

  if (!target || target.banned) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (target.id === me.id) {
    res.status(400).json({ error: 'You cannot message yourself' });
    return;
  }

  const existing = await prisma.chat.findFirst({
    where: {
      type: 'DIRECT',
      members: { some: { userId: me.id } },
      AND: { members: { some: { userId: target.id } } },
    },
    include: memberInclude,
  });

  if (existing && existing.members.length === 2) {
    res.json({ chat: chatSummary(existing, me.id) });
    return;
  }

  const chat = await prisma.chat.create({
    data: {
      type: 'DIRECT',
      createdBy: me.id,
      members: {
        create: [{ userId: me.id }, { userId: target.id }],
      },
    },
    include: memberInclude,
  });

  res.status(201).json({ chat: chatSummary(chat, me.id) });
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(MAX_GROUP_NAME),
  userIds: z.array(z.string().min(1).max(64)).max(MAX_GROUP_MEMBERS - 1).default([]),
});

chatsRouter.post('/groups', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Group name is required (max 50 chars)' });
    return;
  }

  const userIds = [...new Set(parsed.data.userIds)].filter((id) => id !== me.id);
  const targets = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, banned: false },
        select: { id: true },
      })
    : [];

  const chat = await prisma.chat.create({
    data: {
      type: 'GROUP',
      name: parsed.data.name,
      createdBy: me.id,
      members: {
        create: [
          { userId: me.id, role: 'owner' },
          ...targets.map((t) => ({ userId: t.id, role: 'member' })),
        ],
      },
    },
    include: memberInclude,
  });

  const io = ioFrom(req);
  for (const t of targets) {
    io?.to(`user:${t.id}`).emit('chat:new', { chat: chatSummary(chat, t.id) });
  }

  res.status(201).json({ chat: chatSummary(chat, me.id) });
});

const addMembersSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_GROUP_MEMBERS),
});

chatsRouter.post('/:id/members', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  if (chat.type !== 'GROUP') {
    res.status(400).json({ error: 'Only groups can have members added' });
    return;
  }

  const myRole = memberRole(chat, me.id);
  if (myRole !== 'owner' && myRole !== 'admin') {
    res.status(403).json({ error: 'Owner or admin required' });
    return;
  }

  const parsed = addMembersSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide userIds to add' });
    return;
  }

  const ids = [...new Set(parsed.data.userIds)].filter((id) => id !== me.id);
  const targets = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids }, banned: false }, select: { id: true } })
    : [];

  const existingIds = new Set(chat.members.map((m) => m.userId));
  const toAdd = targets.filter((t) => !existingIds.has(t.id));
  if (toAdd.length === 0) {
    res.status(409).json({ error: 'No new members to add' });
    return;
  }
  if (chat.members.length + toAdd.length > MAX_GROUP_MEMBERS) {
    res.status(400).json({ error: `Group member limit is ${MAX_GROUP_MEMBERS}` });
    return;
  }

  await prisma.chatMember.createMany({
    data: toAdd.map((t) => ({ chatId: chat.id, userId: t.id, role: 'member' })),
    skipDuplicates: true,
  });
  await prisma.chat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });

  const updated = await getChatWithMembership(chat.id, me.id);
  if (!updated) {
    res.status(500).json({ error: 'Update failed' });
    return;
  }

  const io = ioFrom(req);
  const members = updated.members.map(chatMemberShape);
  io?.to(`chat:${chat.id}`).emit('chat:members', { chatId: chat.id, members });
  for (const t of toAdd) {
    io?.to(`user:${t.id}`).emit('chat:new', { chat: chatSummary(updated, t.id) });
  }

  res.json({ ok: true, members });
});

const roleChangeSchema = z.object({ role: z.enum(['admin', 'member']) });

chatsRouter.patch('/:id/members/:userId/role', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  if (chat.type !== 'GROUP') {
    res.status(400).json({ error: 'Only groups have roles' });
    return;
  }
  if (memberRole(chat, me.id) !== 'owner') {
    res.status(403).json({ error: 'Owner required' });
    return;
  }

  const parsed = roleChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }

  const target = chat.members.find((m) => m.userId === req.params.userId);
  if (!target) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }
  if (target.userId === me.id) {
    res.status(400).json({ error: 'Cannot change your own role' });
    return;
  }
  if (target.role === 'owner') {
    res.status(400).json({ error: 'Owner role cannot be changed' });
    return;
  }

  await prisma.chatMember.update({
    where: { chatId_userId: { chatId: chat.id, userId: target.userId } },
    data: { role: parsed.data.role },
  });

  const updated = await getChatWithMembership(chat.id, me.id);
  const members = updated?.members.map(chatMemberShape) ?? [];
  ioFrom(req)?.to(`chat:${chat.id}`).emit('chat:members', { chatId: chat.id, members });

  res.json({ ok: true, members });
});

const infoSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_GROUP_NAME).optional(),
    avatarUrl: z
      .union([
        z.null(),
        z
          .string()
          .trim()
          .max(1024)
          .refine((value) => attachmentUrlAllowed(value), 'URL is not allowed'),
      ])
      .optional(),
  })
  .refine((value) => value.name !== undefined || value.avatarUrl !== undefined, {
    message: 'Provide a name or an avatarUrl',
  });

chatsRouter.patch('/:id', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  if (chat.type !== 'GROUP') {
    res.status(400).json({ error: 'Only groups can be updated' });
    return;
  }
  const myRole = memberRole(chat, me.id);
  if (myRole !== 'owner' && myRole !== 'admin') {
    res.status(403).json({ error: 'Owner or admin required' });
    return;
  }

  const parsed = infoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid group update' });
    return;
  }
  await prisma.chat.update({
    where: { id: chat.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.avatarUrl !== undefined ? { avatarUrl: parsed.data.avatarUrl } : {}),
    },
  });
  const updated = await getChatWithMembership(chat.id, me.id);
  ioFrom(req)?.to(`chat:${chat.id}`).emit('chat:updated', {
    chatId: chat.id,
    name: parsed.data.name,
    avatarUrl: parsed.data.avatarUrl,
  });

  res.json({ ok: true, chat: updated ? chatSummary(updated, me.id) : null });
});

/**
 * Shared member-removal logic (used by DELETE /:id/members/:userId and
 * POST /:id/leave). The owner cannot be removed by others; the owner leaving
 * promotes the earliest-joined remaining member. Groups/DMs that would be left
 * empty (a DM with a single remaining member) are deleted entirely.
 */
async function removeMemberInternal(
  chat: ChatWithMembers,
  meId: string,
  targetId: string,
  io: Io | undefined,
): Promise<{ status: number; ok: boolean; error?: string; deleted?: boolean; members?: SerializedChatMember[] }> {
  const target = chat.members.find((m) => m.userId === targetId);
  if (!target) return { status: 404, ok: false, error: 'Member not found' };

  const removingSelf = targetId === meId;
  if (target.role === 'owner') {
    if (!removingSelf) {
      return { status: 403, ok: false, error: 'The owner cannot be removed' };
    }
  } else if (!removingSelf) {
    const myRole = memberRole(chat, meId);
    if (myRole === 'admin' && target.role !== 'member') {
      return { status: 403, ok: false, error: 'Admins can only remove members' };
    }
    if (myRole !== 'owner' && myRole !== 'admin') {
      return { status: 403, ok: false, error: 'Owner or admin required' };
    }
  }

  if (removingSelf && chat.members.length > 1) {
    const successor = chat.members
      .filter((m) => m.userId !== meId)
      .sort((a, b) => a.id.localeCompare(b.id))[0]!;
    await prisma.chatMember.update({
      where: { chatId_userId: { chatId: chat.id, userId: successor.userId } },
      data: { role: 'owner' },
    });
  }

  await prisma.chatMember.delete({
    where: { chatId_userId: { chatId: chat.id, userId: targetId } },
  });

  const remaining = await prisma.chatMember.count({ where: { chatId: chat.id } });
  if (remaining === 0 || (chat.type === 'DIRECT' && remaining <= 1)) {
    await prisma.chat.delete({ where: { id: chat.id } });
    return { status: 200, ok: true, deleted: true };
  }

  await prisma.chat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });

  let members: SerializedChatMember[] | undefined;
  if (chat.type === 'GROUP') {
    const updated = await prisma.chat.findUnique({
      where: { id: chat.id },
      include: memberInclude,
    });
    members = (updated?.members ?? []).map(chatMemberShape);
    io?.to(`chat:${chat.id}`).emit('chat:members', { chatId: chat.id, members });
  }
  io?.to(`user:${targetId}`).emit('chat:removed', { chatId: chat.id });

  return { status: 200, ok: true, deleted: false, members };
}

chatsRouter.delete('/:id/members/:userId', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  if (chat.type !== 'GROUP') {
    res.status(400).json({ error: 'Only groups support member management' });
    return;
  }

  const result = await removeMemberInternal(chat, me.id, req.params.userId, ioFrom(req));
  res
    .status(result.status)
    .json(result.ok ? { ok: true, deleted: result.deleted ?? false, members: result.members } : { error: result.error });
});

chatsRouter.post('/:id/leave', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const result = await removeMemberInternal(chat, me.id, me.id, ioFrom(req));
  res
    .status(result.status)
    .json(result.ok ? { ok: true, deleted: result.deleted ?? false, members: result.members } : { error: result.error });
});

const listMessagesSchema = z.object({
  before: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

chatsRouter.get('/:id/messages', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  if (chat.members.some((m) => m.user.banned)) {
    res.status(403).json({ error: 'Chat unavailable' });
    return;
  }

  const parsed = listMessagesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query' });
    return;
  }

  let cursor: { createdAt: Date; id: string } | null = null;
  if (parsed.data.before) {
    const beforeMsg = await prisma.message.findUnique({
      where: { id: parsed.data.before },
      select: { id: true, createdAt: true, chatId: true },
    });
    if (!beforeMsg || beforeMsg.chatId !== chat.id) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    cursor = beforeMsg;
  }

  const messages = await prisma.message.findMany({
    where: {
      chatId: chat.id,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: parsed.data.limit + 1,
  });

  const hasMore = messages.length > parsed.data.limit;
  const page = hasMore ? messages.slice(0, parsed.data.limit) : messages;
  page.reverse();

  res.json({
    messages: page.map(serializeMessage),
    hasMore,
    readCutoffs: chat.members
      .filter((m) => m.userId !== me.id)
      .map((m) => ({ userId: m.userId, lastReadAt: m.lastReadAt.toISOString() })),
  });
});

chatsRouter.post('/:id/read', async (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const chat = await getChatWithMembership(req.params.id, me.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const now = new Date();
  await prisma.chatMember.update({
    where: { chatId_userId: { chatId: chat.id, userId: me.id } },
    data: { lastReadAt: now },
  });

  ioFrom(req)?.to(`chat:${chat.id}`).emit('messages:read', {
    chatId: chat.id,
    userId: me.id,
    readAt: now.toISOString(),
  });

  res.json({ ok: true, readAt: now.toISOString() });
});

export { MAX_MESSAGE_LENGTH, otherMembers };