export interface User {
  id: string;
  username: string;
  email: string;
  role: 'USER' | 'ADMIN';
  banned: boolean;
  avatarUrl: string | null;
  createdAt: string;
}

export type ChatRole = 'owner' | 'admin' | 'member';

export type AttachmentKind = 'image' | 'video' | 'raw';

export interface Attachment {
  resourceType: AttachmentKind;
  url: string;
  publicId: string | null;
  name: string | null;
  mime: string | null;
  size: number;
  width: number | null;
  height: number | null;
}

export interface AttachmentPreview {
  kind: 'image' | 'video' | 'file';
  name: string;
}

export interface ChatMemberInfo {
  userId: string;
  username: string;
  e2ePublicKey: string | null;
  avatarUrl: string | null;
  role: ChatRole;
  online?: boolean;
}

export interface ChatListItem {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarUrl: string | null;
  updatedAt: string;
  members: ChatMemberInfo[];
  myRole: ChatRole | null;
  lastMessage: {
    id: string;
    content: string | null;
    senderId: string;
    isE2ee: boolean;
    nonce: string | null;
    attachment: AttachmentPreview | null;
    createdAt: string;
  } | null;
  unreadCount: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string;
  sender: { id: string; username: string };
  content: string | null;
  isE2ee: boolean;
  nonce: string | null;
  attachment: Attachment | null;
  createdAt: string;
  tempId?: string;
  status?: 'pending' | 'sent' | 'failed';
}

export interface ChatSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarUrl: string | null;
  members: ChatMemberInfo[];
  myRole: ChatRole | null;
}
