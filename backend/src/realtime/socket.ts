import type { Server, Socket } from 'socket.io';
import { prisma } from '../db.js';
import {
  getChatWithMembership,
  lastMessagePreview,
  MAX_MESSAGE_LENGTH,
  serializeMessage,
  type ChatWithMembers,
} from '../lib/chat.js';
import {
  attachmentSchema,
  encryptAttachment,
  isAttachmentUrlAllowed,
  type AttachmentDescriptor,
} from '../lib/attachments.js';
import { encryptMessage } from '../lib/messageCrypto.js';
import { notifyUsersViaPush } from '../lib/push.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { isProduction } from '../config.js';

interface SocketUser {
  id: string;
  username: string;
  role: 'USER' | 'ADMIN';
}

declare module 'socket.io' {
  interface SocketData {
    user: SocketUser;
    subscribedChats: Set<string>;
  }
}

/** userId → set of connected socket ids */
const onlineUsers = new Map<string, Set<string>>();

function addOnline(userId: string, socketId: string): boolean {
  let sockets = onlineUsers.get(userId);
  const first = !sockets;
  if (!sockets) {
    sockets = new Set();
    onlineUsers.set(userId, sockets);
  }
  sockets.add(socketId);
  return first;
}

function removeOnline(userId: string, socketId: string): boolean {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    onlineUsers.delete(userId);
    return true;
  }
  return false;
}

function isOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}

async function chatIdsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.chatMember.findMany({
    where: { userId },
    select: { chatId: true },
  });
  return rows.map((r) => r.chatId);
}

function memberPresence(chat: ChatWithMembers, userId: string) {
  return chat.members
    .filter((m) => m.userId !== userId)
    .map((m) => ({
      userId: m.userId,
      username: m.user.username,
      e2ePublicKey: m.user.e2ePublicKey,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      online: isOnline(m.userId),
    }));
}

function canUseChatRoom(socket: Socket, chatId: string): boolean {
  return socket.data.subscribedChats.has(chatId) && socket.rooms.has(`chat:${chatId}`);
}

export function attachRealtime(io: Server): void {
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: unknown };
      const token = typeof auth.token === 'string' ? auth.token : null;
      if (!token) {
        next(new Error('unauthorized'));
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload) {
        next(new Error('unauthorized'));
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, username: true, role: true, banned: true },
      });
      if (!user || user.banned) {
        next(new Error('unauthorized'));
        return;
      }

      socket.data.user = { id: user.id, username: user.username, role: user.role };
      socket.data.subscribedChats = new Set();
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const room = `user:${user.id}`;
    socket.join(room);

    const becameOnline = addOnline(user.id, socket.id);
    let chatIds: string[] = [];

    void chatIdsForUser(user.id).then((ids) => {
      chatIds = ids;
      if (becameOnline) {
        for (const chatId of ids) {
          socket.to(`chat:${chatId}`).emit('presence:update', {
            chatId,
            userId: user.id,
            online: true,
          });
        }
      }
    });

    socket.on('chat:subscribe', async (payload: unknown, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const chatId =
        typeof payload === 'object' && payload !== null && 'chatId' in payload
          ? String((payload as { chatId: unknown }).chatId)
          : null;
      if (!chatId) {
        respond({ ok: false, error: 'chatId required' });
        return;
      }

      const chat = await getChatWithMembership(chatId, user.id);
      if (!chat) {
        respond({ ok: false, error: 'Chat not found' });
        return;
      }

      socket.join(`chat:${chatId}`);
      socket.data.subscribedChats.add(chatId);
      respond({ ok: true, members: memberPresence(chat, user.id) });
    });

    socket.on('chat:unsubscribe', (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null || !('chatId' in payload)) return;
      const chatId = String((payload as { chatId: unknown }).chatId);
      socket.leave(`chat:${chatId}`);
      socket.data.subscribedChats.delete(chatId);
    });

    socket.on('message:send', async (payload: unknown, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};

      const body =
        typeof payload === 'object' && payload !== null
          ? (payload as {
              chatId?: unknown;
              content?: unknown;
              nonce?: unknown;
              isE2ee?: unknown;
              tempId?: unknown;
              attachment?: unknown;
            })
          : {};
      const chatId = typeof body.chatId === 'string' ? body.chatId : null;
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const nonce = typeof body.nonce === 'string' ? body.nonce : '';
      const isE2ee = body.isE2ee === true;
      const tempId = typeof body.tempId === 'string' ? body.tempId.slice(0, 64) : null;

      let attachment: AttachmentDescriptor | null = null;
      if (body.attachment !== undefined && body.attachment !== null) {
        const parsedAttachment = attachmentSchema.safeParse(body.attachment);
        const descriptor = parsedAttachment.success ? parsedAttachment.data : null;
        const urls = [descriptor?.url ?? '', ...(descriptor?.parts ?? []).map((part) => part.url)];
        if (!descriptor || !urls.every((url) => isAttachmentUrlAllowed(url))) {
          respond({ ok: false, error: 'Invalid attachment', tempId });
          return;
        }
        attachment = descriptor;
      }

      if (!chatId || (!content && !attachment)) {
        respond({ ok: false, error: 'chatId and content (or attachment) are required', tempId });
        return;
      }

      const chat = await getChatWithMembership(chatId, user.id);
      if (!chat) {
        respond({ ok: false, error: 'Chat not found', tempId });
        return;
      }
      if (chat.members.some((m) => m.user.banned)) {
        respond({ ok: false, error: 'Chat unavailable', tempId });
        return;
      }

      let ciphertext: string;
      let storedNonce: string;

      if (isE2ee) {
        // E2EE DMs: the client-encrypted envelope is stored verbatim.
        // The server never sees the plaintext key material for these.
        if (chat.type !== 'DIRECT') {
          respond({ ok: false, error: 'End-to-end encryption is only available in direct chats', tempId });
          return;
        }
        const ctBuf = Buffer.from(content, 'base64');
        const ivBuf = Buffer.from(nonce, 'base64');
        if (ctBuf.toString('base64') !== content || ctBuf.length < 17 || ctBuf.length > 16016) {
          respond({ ok: false, error: 'Invalid encrypted payload', tempId });
          return;
        }
        if (ivBuf.length !== 12 || ivBuf.toString('base64') !== nonce) {
          respond({ ok: false, error: 'Invalid encryption nonce', tempId });
          return;
        }
        ciphertext = content;
        storedNonce = nonce;
      } else {
        if (content.length > MAX_MESSAGE_LENGTH) {
          respond({ ok: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH})`, tempId });
          return;
        }
        const encrypted = encryptMessage(content);
        ciphertext = encrypted.ciphertext;
        storedNonce = encrypted.nonce;
      }

      const attachmentEncrypted = attachment ? encryptAttachment(attachment) : null;
      const message = await prisma.message.create({
        data: {
          chatId,
          senderId: user.id,
          ciphertext,
          nonce: storedNonce,
          isE2ee,
          attachmentCiphertext: attachmentEncrypted?.ciphertext ?? null,
          attachmentNonce: attachmentEncrypted?.nonce ?? null,
        },
        include: { sender: { select: { id: true, username: true } } },
      });
      await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });

      const serialized = serializeMessage(message);
      const outgoing = { ...serialized, tempId };

      io.to(`chat:${chatId}`).emit('message:new', outgoing);

      const recipients = chat.members.map((m) => m.userId).filter((id) => id !== user.id);
      if (recipients.length > 0) {
        const chatName = chat.type === 'GROUP' ? (chat.name ?? 'Group chat') : null;
        const title = chat.type === 'DIRECT' ? user.username : `${user.username} in ${chatName}`;
        let body = 'New message';
        if (attachment?.name) {
          body = `📎 ${attachment.name}`;
        } else if (!isE2ee && content) {
          body = content.length > 120 ? `${content.slice(0, 120)}…` : content;
        } else if (isE2ee) {
          body = 'New encrypted message';
        }
        void notifyUsersViaPush(io, chat.id, recipients, {
          title,
          body,
          chatId,
          url: `/#/?pushchat=${encodeURIComponent(chatId)}`,
        });
      }

      const lastMessage = lastMessagePreview(serialized);
      for (const member of chat.members) {
        if (member.userId === user.id) continue;
        io.to(`user:${member.userId}`).emit('chat:updated', {
          chatId,
          lastMessage,
          updatedAt: lastMessage.createdAt,
        });
      }

      respond({ ok: true, message: outgoing });
    });

    socket.on('typing', (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const body = payload as { chatId?: unknown; isTyping?: unknown };
      const chatId = typeof body.chatId === 'string' ? body.chatId : null;
      const isTyping = body.isTyping === true;
      if (!chatId || !canUseChatRoom(socket, chatId)) return;

      socket.to(`chat:${chatId}`).emit('typing', {
        chatId,
        userId: user.id,
        username: user.username,
        isTyping,
      });
    });

    socket.on('message:read', async (payload: unknown, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (typeof payload !== 'object' || payload === null) {
        respond({ ok: false, error: 'chatId required' });
        return;
      }
      const chatId = String((payload as { chatId?: unknown }).chatId ?? '');
      if (!chatId) {
        respond({ ok: false, error: 'chatId required' });
        return;
      }

      const chat = await getChatWithMembership(chatId, user.id);
      if (!chat) {
        respond({ ok: false, error: 'Chat not found' });
        return;
      }

      const now = new Date();
      await prisma.chatMember.update({
        where: { chatId_userId: { chatId, userId: user.id } },
        data: { lastReadAt: now },
      });

      io.to(`chat:${chatId}`).emit('messages:read', {
        chatId,
        userId: user.id,
        readAt: now.toISOString(),
      });
      respond({ ok: true, readAt: now.toISOString() });
    });

    socket.on('disconnect', () => {
      const wentOffline = removeOnline(user.id, socket.id);
      if (wentOffline) {
        for (const chatId of chatIds) {
          socket.to(`chat:${chatId}`).emit('presence:update', {
            chatId,
            userId: user.id,
            online: false,
          });
        }
      }
    });
  });

  if (!isProduction) {
    console.info('[realtime] Socket.IO attached');
  }
}
