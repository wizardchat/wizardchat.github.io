import { prisma } from '../db.js';
import { attachmentPreview, decryptAttachment, type AttachmentDescriptor, type AttachmentPreview } from './attachments.js';
import { decryptMessage } from './messageCrypto.js';

export const MAX_MESSAGE_LENGTH = 4000;

export interface ChatWithMembers {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarUrl: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: {
    id: string;
    userId: string;
    role: string;
    lastReadAt: Date;
    user: { id: string; username: string; banned: boolean; e2ePublicKey: string | null; avatarUrl: string | null };
  }[];
}

/** Returns the chat only if `userId` is a member; null otherwise (no existence leak). */
export async function getChatWithMembership(
  chatId: string,
  userId: string,
): Promise<ChatWithMembers | null> {
  return prisma.chat.findFirst({
    where: { id: chatId, members: { some: { userId } } },
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
    },
  });
}

export function otherMembers(chat: ChatWithMembers, userId: string) {
  return chat.members.filter((m) => m.userId !== userId);
}

export interface SerializedMessage {
  id: string;
  chatId: string;
  senderId: string;
  sender: { id: string; username: string };
  content: string | null;
  isE2ee: boolean;
  nonce: string | null;
  attachment: AttachmentDescriptor | null;
  createdAt: string;
}

/**
 * Server-encrypted messages are decrypted here; E2EE envelopes are passed
 * through untouched (content = base64 ciphertext, nonce = base64 IV) so the
 * recipient client can decrypt locally — the server cannot read them.
 * Attachment descriptors are server-encrypted and decrypted here for all
 * message types (the server must route them regardless of the caption's E2EE).
 */
export function serializeMessage(m: {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  nonce: string;
  isE2ee: boolean;
  attachmentCiphertext: string | null;
  attachmentNonce: string | null;
  createdAt: Date;
  sender: { id: string; username: string };
}): SerializedMessage {
  let content: string | null;
  let nonce: string | null;
  if (m.isE2ee) {
    content = m.ciphertext;
    nonce = m.nonce;
  } else {
    try {
      content = decryptMessage({ ciphertext: m.ciphertext, nonce: m.nonce });
    } catch {
      content = null;
    }
    nonce = null;
  }
  return {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    sender: m.sender,
    content,
    isE2ee: m.isE2ee,
    nonce,
    attachment: decryptAttachment({
      ciphertext: m.attachmentCiphertext,
      nonce: m.attachmentNonce,
    }),
    createdAt: m.createdAt.toISOString(),
  };
}

export function lastMessagePreview(m: SerializedMessage): {
  id: string;
  content: string | null;
  senderId: string;
  isE2ee: boolean;
  nonce: string | null;
  attachment: AttachmentPreview | null;
  createdAt: string;
} {
  return {
    id: m.id,
    content: m.content,
    senderId: m.senderId,
    isE2ee: m.isE2ee,
    nonce: m.nonce,
    attachment: m.attachment ? attachmentPreview(m.attachment) : null,
    createdAt: m.createdAt,
  };
}

export function directDisplayName(chat: ChatWithMembers, userId: string): string | null {
  if (chat.type !== 'DIRECT') return chat.name;
  const other = otherMembers(chat, userId)[0];
  return other?.user.username ?? null;
}

export type ChatRole = 'owner' | 'admin' | 'member';

export interface SerializedChatMember {
  userId: string;
  username: string;
  e2ePublicKey: string | null;
  avatarUrl: string | null;
  role: ChatRole;
}

export function memberRole(chat: ChatWithMembers, userId: string): ChatRole | null {
  const m = chat.members.find((x) => x.userId === userId);
  if (m && (m.role === 'owner' || m.role === 'admin' || m.role === 'member')) return m.role;
  return null;
}

export function chatMemberShape(m: ChatWithMembers['members'][number]): SerializedChatMember {
  return {
    userId: m.userId,
    username: m.user.username,
    e2ePublicKey: m.user.e2ePublicKey,
    avatarUrl: m.user.avatarUrl,
    role: memberRole({ members: [m] } as ChatWithMembers, m.userId) ?? 'member',
  };
}

export interface ChatSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarUrl: string | null;
  members: SerializedChatMember[];
  myRole: ChatRole | null;
}

export function chatSummary(chat: ChatWithMembers, meId: string): ChatSummary {
  return {
    id: chat.id,
    type: chat.type,
    name: directDisplayName(chat, meId),
    avatarUrl: chat.avatarUrl,
    members: chat.members.map(chatMemberShape),
    myRole: memberRole(chat, meId),
  };
}
