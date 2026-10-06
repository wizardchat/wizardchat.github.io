import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import ChatList from '../components/ChatList';
import Conversation from '../components/Conversation';
import GroupManageDialog from '../components/GroupManageDialog';
import NewChatDialog from '../components/NewChatDialog';
import UnlockBanner from '../components/UnlockBanner';
import { useAuth } from '../lib/auth';
import {
  createDirectChat,
  createGroup,
  fetchMessages,
  getAccessToken,
  listChats,
  markChatRead,
} from '../lib/chatApi';
import { decryptChatMessage, encryptMessage, loadIdentity, LOCKED_PLACEHOLDER } from '../lib/e2ee';
import { uploadAttachment } from '../lib/upload';
import { connectSocket, disconnectSocket, getSocket } from '../lib/socket';
import type { Attachment, AttachmentPreview, ChatListItem, ChatMemberInfo, ChatMessage } from '../lib/types';
import type { Socket } from 'socket.io-client';

interface NewMessageEvent extends ChatMessage {
  tempId?: string;
}

interface SendWire {
  content: string;
  nonce: string | null;
  isE2ee: boolean;
  attachment?: Attachment;
}

interface SendAck {
  ok: boolean;
  error?: string;
  message?: ChatMessage;
}

function previewFor(attachment: Attachment): AttachmentPreview {
  return {
    kind: attachment.resourceType === 'raw' ? 'file' : attachment.resourceType,
    name: attachment.name ?? attachment.publicId ?? 'attachment',
  };
}

async function decryptPreview(chat: ChatListItem, meId: string): Promise<ChatListItem> {
  const last = chat.lastMessage;
  if (!last?.isE2ee) return chat;
  const content = await decryptChatMessage(
    { content: last.content, isE2ee: true, nonce: last.nonce, chatId: chat.id, senderId: last.senderId },
    chat.members,
    meId,
  );
  return { ...chat, lastMessage: { ...last, content } };
}

async function decryptHistory(
  messages: ChatMessage[],
  members: ChatMemberInfo[],
  meId: string,
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (m) => (m.isE2ee ? { ...m, content: await decryptChatMessage(m, members, meId) } : m)),
  );
}

export default function Chat() {
  const { user, logout, e2eState, updateProfile } = useAuth();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChat, setActiveChat] = useState<ChatListItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [readCutoffs, setReadCutoffs] = useState<Record<string, string>>({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [manageChatId, setManageChatId] = useState<string | null>(null);
  const [sendQueue, setSendQueue] = useState<(SendWire & { tempId: string; chatId: string })[]>([]);

  const activeChatRef = useRef<ChatListItem | null>(null);
  const chatsRef = useRef<ChatListItem[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    activeChatRef.current = activeChat;
  }, [activeChat]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  // Keep the active chat in sync with the freshest list entry so member
  // lists / roles / names reflect group updates after they are refreshed.
  useEffect(() => {
    if (!activeChat) return;
    const fresh = chats.find((c) => c.id === activeChat.id);
    if (!fresh) {
      setActiveChat(null);
      setMessages([]);
      return;
    }
    if (fresh !== activeChat) setActiveChat(fresh);
  }, [chats, activeChat]);

  const refreshChats = useCallback(async () => {
    if (!user) return;
    try {
      const list = await listChats();
      setChats(await Promise.all(list.map((c) => decryptPreview(c, user.id))));
    } catch {
      // Non-fatal; user can retry.
    }
  }, [user]);

  const sendWithSocket = useCallback((tempId: string, chatId: string, wire: SendWire) => {
    const socket = getSocket();
    if (!socket?.connected) return false;
    socket.emit(
      'message:send',
      { chatId, content: wire.content, nonce: wire.nonce, isE2ee: wire.isE2ee, tempId, attachment: wire.attachment },
      (res: SendAck) => {
        if (res.ok && res.message) {
          const serverId = res.message.id;
          setMessages((prev) =>
            prev.map((m) => (m.tempId === tempId ? { ...m, id: serverId, status: 'sent' as const } : m)),
          );
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m)),
          );
        }
      },
    );
    return true;
  }, []);

  // Connect socket when authenticated
  useEffect(() => {
    if (!user) {
      disconnectSocket();
      return;
    }
    const token = getAccessToken();
    if (!token) return;

    const socket = connectSocket(token);
    socketRef.current = socket;

    const onMessageNew = async (raw: NewMessageEvent) => {
      const active = activeChatRef.current;
      let message: ChatMessage = raw;

      if (raw.isE2ee) {
        const members =
          chatsRef.current.find((c) => c.id === raw.chatId)?.members ??
          (active?.id === raw.chatId ? active.members : null);
        if (members) {
          message = { ...raw, content: await decryptChatMessage(raw, members, user.id) };
        } else {
          message = { ...raw, content: LOCKED_PLACEHOLDER };
          void refreshChats();
        }
      }

      const isActive = active?.id === message.chatId;

      setChats((prev) =>
        prev.map((chat) => {
          if (chat.id !== message.chatId) return chat;
          return {
            ...chat,
            updatedAt: message.createdAt,
            lastMessage: {
              id: message.id,
              content: message.content,
              senderId: message.senderId,
              isE2ee: message.isE2ee,
              nonce: message.nonce,
              attachment: message.attachment ? previewFor(message.attachment) : null,
              createdAt: message.createdAt,
            },
            unreadCount:
              message.senderId !== user.id && !isActive ? chat.unreadCount + 1 : chat.unreadCount,
          };
        }),
      );

      if (!isActive) return;

      setMessages((prev) => {
        if (message.tempId) {
          const idx = prev.findIndex((m) => m.tempId === message.tempId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...message, status: 'sent' };
            return next;
          }
        }
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, { ...message, status: 'sent' }];
      });

      if (message.senderId !== user.id) {
        void markChatRead(message.chatId)
          .then(({ readAt }) => {
            setReadCutoffs((prev) => ({ ...prev, [user.id]: readAt }));
            socket.emit('message:read', { chatId: message.chatId });
          })
          .catch(() => {});
      }
    };

    const onChatUpdated = async (payload: {
      chatId: string;
      lastMessage?: ChatListItem['lastMessage'];
      updatedAt?: string;
      name?: string;
    }) => {
      const chatName = typeof payload.name === 'string' ? payload.name : undefined;
      let lastMessage = payload.lastMessage ?? null;
      if (lastMessage?.isE2ee) {
        const members = chatsRef.current.find((c) => c.id === payload.chatId)?.members;
        if (members) {
          lastMessage = {
            ...lastMessage,
            content: await decryptChatMessage(
              { ...lastMessage, chatId: payload.chatId },
              members,
              user.id,
            ),
          };
        } else {
          lastMessage = { ...lastMessage, content: LOCKED_PLACEHOLDER };
        }
      }

      setChats((prev) => {
        const exists = prev.some((c) => c.id === payload.chatId);
        if (!exists) {
          void refreshChats();
          return prev;
        }
        return prev.map((chat) =>
          chat.id === payload.chatId
            ? {
                ...chat,
                ...(chatName !== undefined ? { name: chatName } : {}),
                updatedAt: payload.updatedAt ?? chat.updatedAt,
                lastMessage: lastMessage ?? chat.lastMessage,
              }
            : chat,
        );
      });
    };

    const onChatNew = () => {
      void refreshChats();
    };

    const onChatMembers = (payload: { chatId: string; members: ChatMemberInfo[] }) => {
      setChats((prev) =>
        prev.map((c) => (c.id === payload.chatId ? { ...c, members: payload.members } : c)),
      );
    };

    const onChatRemoved = (payload: { chatId: string }) => {
      setChats((prev) => prev.filter((c) => c.id !== payload.chatId));
    };

    const onTyping = (payload: { chatId: string; userId: string; username: string; isTyping: boolean }) => {
      setTypingUsers((prev) => {
        const list = prev[payload.chatId] ?? [];
        const next = payload.isTyping
          ? list.includes(payload.username)
            ? list
            : [...list, payload.username]
          : list.filter((u) => u !== payload.username);
        return { ...prev, [payload.chatId]: next };
      });
    };

    const onMessagesRead = (payload: { chatId: string; userId: string; readAt: string }) => {
      if (payload.userId === user.id) {
        setReadCutoffs((prev) => ({ ...prev, [user.id]: payload.readAt }));
        return;
      }
      setReadCutoffs((prev) => ({ ...prev, [payload.userId]: payload.readAt }));
    };

    const onPresence = (payload: { chatId: string; userId: string; online: boolean }) => {
      setPresence((prev) => ({ ...prev, [payload.userId]: payload.online }));
    };

    const onMessagesDeleted = (payload: { chatId: string; messageIds: string[] }) => {
      setMessages((prev) => {
        const ids = new Set(payload.messageIds);
        const next = prev.filter((m) => !ids.has(m.id));
        return next.length === prev.length ? prev : next;
      });
    };

    socket.on('message:new', onMessageNew);
    socket.on('chat:updated', onChatUpdated);
    socket.on('chat:new', onChatNew);
    socket.on('chat:members', onChatMembers);
    socket.on('chat:removed', onChatRemoved);
    socket.on('typing', onTyping);
    socket.on('messages:read', onMessagesRead);
    socket.on('presence:update', onPresence);
    socket.on('messages:deleted', onMessagesDeleted);
    socket.on('connect', () => {
      const active = activeChatRef.current;
      if (active) {
        socket.emit('chat:subscribe', { chatId: active.id }, (res: { ok: boolean; members?: { userId: string; online: boolean }[] }) => {
          if (res.ok && res.members) {
            setPresence((prev) => {
              const next = { ...prev };
              for (const m of res.members ?? []) next[m.userId] = m.online;
              return next;
            });
          }
        });
      }
    });

    return () => {
      socket.off('message:new', onMessageNew);
      socket.off('chat:updated', onChatUpdated);
      socket.off('chat:new', onChatNew);
      socket.off('chat:members', onChatMembers);
      socket.off('chat:removed', onChatRemoved);
      socket.off('typing', onTyping);
      socket.off('messages:read', onMessagesRead);
      socket.off('presence:update', onPresence);
      socket.off('messages:deleted', onMessagesDeleted);
      socket.off('connect');
    };
  }, [user, refreshChats]);

  useEffect(() => {
    if (user) void refreshChats();
  }, [user, refreshChats]);

  // When the E2EE identity becomes available (boot or after unlock), refresh
  // list previews and re-fetch the open conversation so locked messages decrypt.
  const prevE2eRef = useRef<string>('loading');
  useEffect(() => {
    const prev = prevE2eRef.current;
    prevE2eRef.current = e2eState;
    if (e2eState === 'ready' && prev !== 'ready') {
      void refreshChats();
      const active = activeChatRef.current;
      if (active) void handleSelectChat(active);
    }
  }, [e2eState, refreshChats]);

  // Flush optimistic send queue when socket connects
  useEffect(() => {
    const socket = getSocket();
    if (!socket || sendQueue.length === 0) return;

    const flush = () => {
      for (const item of sendQueue) {
        const { tempId, chatId, ...wire } = item;
        sendWithSocket(tempId, chatId, wire);
      }
      setSendQueue([]);
    };

    if (socket.connected) flush();
    else socket.once('connect', flush);
  }, [sendQueue, sendWithSocket]);

  const handleSelectChat = useCallback(
    async (chat: ChatListItem) => {
      setActiveChat(chat);
      setMessages([]);
      setHasMore(false);
      setTypingUsers((prev) => ({ ...prev, [chat.id]: [] }));
      const socket = getSocket();
      socket?.emit('chat:subscribe', { chatId: chat.id }, (res: { ok: boolean; members?: { userId: string; online: boolean }[] }) => {
        if (res.ok && res.members) {
          setPresence((prev) => {
            const next = { ...prev };
            for (const m of res.members ?? []) next[m.userId] = m.online;
            return next;
          });
        }
      });

      try {
        setLoadingHistory(true);
        const data = await fetchMessages(chat.id);
        const decrypted = await decryptHistory(data.messages, chat.members, user?.id ?? '');
        setMessages(decrypted.map((m) => ({ ...m, status: 'sent' as const })));
        setHasMore(data.hasMore);
        setReadCutoffs((prev) => {
          const next = { ...prev };
          for (const cutoff of data.readCutoffs) next[cutoff.userId] = cutoff.lastReadAt;
          return next;
        });
        if (data.messages.length > 0) {
          const res = await markChatRead(chat.id);
          setReadCutoffs((prev) => ({ ...prev, [user?.id ?? '']: res.readAt }));
          socket?.emit('message:read', { chatId: chat.id });
          setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c)));
        }
      } catch {
        // Leave empty state; user can retry by reselecting.
      } finally {
        setLoadingHistory(false);
      }
    },
    [user?.id],
  );

  const handleLoadOlder = useCallback(async () => {
    const chat = activeChatRef.current;
    const oldest = messages[0];
    if (!chat || !oldest) return;
    try {
      setLoadingHistory(true);
      const data = await fetchMessages(chat.id, { before: oldest.id });
      const decrypted = await decryptHistory(data.messages, chat.members, user?.id ?? '');
      setMessages((prev) => [...decrypted.map((m) => ({ ...m, status: 'sent' as const })), ...prev]);
      setHasMore(data.hasMore);
    } catch {
      // Ignore pagination errors.
    } finally {
      setLoadingHistory(false);
    }
  }, [messages, user?.id]);

  const handleSend = useCallback(
    async (content: string, attachment?: Attachment) => {
      const chat = activeChatRef.current;
      if (!chat || !user) return;
      const tempId = crypto.randomUUID();
      const caption = content.trim();
      const isE2ee = chat.type === 'DIRECT' && caption.length > 0;

      const optimistic: ChatMessage = {
        id: tempId,
        tempId,
        chatId: chat.id,
        senderId: user.id,
        sender: { id: user.id, username: user.username },
        content: caption,
        isE2ee,
        nonce: null,
        attachment: attachment ?? null,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      setMessages((prev) => [...prev, optimistic]);

      const fail = () =>
        setMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m)));

      let wire: SendWire = { content: caption, nonce: null, isE2ee: false, attachment };
      if (isE2ee) {
        const identity = loadIdentity(user.id);
        const other = chat.members.find((m) => m.userId !== user.id);
        if (!identity || !other?.e2ePublicKey) {
          fail();
          return;
        }
        try {
          const encrypted = await encryptMessage(caption, {
            chatId: chat.id,
            senderId: user.id,
            myIdentity: identity,
            recipientPublicKey: other.e2ePublicKey,
          });
          wire = { content: encrypted.ciphertext, nonce: encrypted.nonce, isE2ee: true, attachment };
        } catch {
          fail();
          return;
        }
      }

      if (!sendWithSocket(tempId, chat.id, wire)) {
        setSendQueue((prev) => [...prev, { tempId, chatId: chat.id, ...wire }]);
      }
    },
    [user, sendWithSocket],
  );

  const handleTyping = useCallback((isTyping: boolean) => {
    const chat = activeChatRef.current;
    const socket = getSocket();
    if (!chat || !socket?.connected) return;
    socket.emit('typing', { chatId: chat.id, isTyping });
  }, []);

  const handleRead = useCallback(() => {
    const chat = activeChatRef.current;
    const socket = getSocket();
    if (!chat || !socket?.connected) return;
    socket.emit('message:read', { chatId: chat.id });
  }, []);

  const handleStartChat = useCallback(
    async (target: { userId: string; username: string }) => {
      setNewChatOpen(false);
      try {
        const chat = await createDirectChat({ userId: target.userId });
        await refreshChats();
        const listItem: ChatListItem = {
          id: chat.id,
          type: chat.type,
          name: chat.name,
          avatarUrl: chat.avatarUrl,
          updatedAt: new Date().toISOString(),
          members: chat.members,
          myRole: chat.myRole,
          lastMessage: null,
          unreadCount: 0,
        };
        setActiveChat(listItem);
        setMessages([]);
        setHasMore(false);
        const socket = getSocket();
        socket?.emit('chat:subscribe', { chatId: chat.id });
      } catch (err) {
        console.error(err);
      }
    },
    [refreshChats],
  );

  const handleCreateGroup = useCallback(
    async (name: string, userIds: string[]) => {
      setNewChatOpen(false);
      try {
        const chat = await createGroup(name, userIds);
        await refreshChats();
        const listItem: ChatListItem = {
          id: chat.id,
          type: chat.type,
          name: chat.name,
          avatarUrl: chat.avatarUrl,
          updatedAt: new Date().toISOString(),
          members: chat.members,
          myRole: chat.myRole,
          lastMessage: null,
          unreadCount: 0,
        };
        setActiveChat(listItem);
        setMessages([]);
        setHasMore(false);
        const socket = getSocket();
        socket?.emit('chat:subscribe', { chatId: chat.id });
      } catch (err) {
        console.error(err);
      }
    },
    [refreshChats],
  );

  const handleGroupChanged = useCallback(
    async (_chatId: string, opts?: { left?: boolean }) => {
      if (opts?.left) setManageChatId(null);
      await refreshChats();
    },
    [refreshChats],
  );

  const handleAvatarFile = useCallback(
    async (file: File) => {
      setAvatarError(null);
      setAvatarUploading(true);
      try {
        const attachment = await uploadAttachment(file);
        await updateProfile({ avatarUrl: attachment.url });
      } catch (err) {
        setAvatarError(err instanceof Error ? err.message : 'Failed to update your picture');
      } finally {
        setAvatarUploading(false);
      }
    },
    [updateProfile],
  );

  const handleRemoveAvatar = useCallback(async () => {
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      await updateProfile({ avatarUrl: null });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to remove your picture');
    } finally {
      setAvatarUploading(false);
    }
  }, [updateProfile]);

  if (!user) return null;

  const manageChat = manageChatId ? (chats.find((c) => c.id === manageChatId) ?? null) : null;

  const composerLocked = activeChat?.type === 'DIRECT' && e2eState !== 'ready';

  return (
    <div className="flex h-screen">
      <aside className="w-80 shrink-0 border-r border-white/5 bg-wizard-green-900">
        <ChatList
          chats={chats}
          activeChatId={activeChat?.id ?? null}
          meId={user.id}
          onSelect={(chat) => void handleSelectChat(chat)}
          onNewChat={() => setNewChatOpen(true)}
        />
        <div className="border-t border-white/5 px-4 py-3">
          {avatarError && <p className="mb-2 text-xs text-red-400">{avatarError}</p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <input
                ref={avatarInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleAvatarFile(file);
                }}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="shrink-0 rounded-full transition hover:opacity-80 disabled:opacity-50"
                title={avatarUploading ? 'Uploading…' : 'Change your picture'}
                aria-label="Change your picture"
              >
                <Avatar url={user.avatarUrl} name={user.username} size={40} />
              </button>
              {user.avatarUrl && (
                <button
                  type="button"
                  onClick={() => void handleRemoveAvatar()}
                  disabled={avatarUploading}
                  className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400 disabled:opacity-50"
                  title="Remove your picture"
                  aria-label="Remove your picture"
                >
                  ✕
                </button>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{user.username}</p>
                {user.email && <p className="truncate text-xs text-wizard-muted">{user.email}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {e2eState === 'locked' && (
          <UnlockBanner
            onUnlocked={() => {
              void refreshChats();
              const active = activeChatRef.current;
              if (active) void handleSelectChat(active);
            }}
          />
        )}
        <div className="min-h-0 flex-1">
          <Conversation
            chat={activeChat}
            meId={user.id}
            messages={messages}
            hasMore={hasMore}
            loadingHistory={loadingHistory}
            typingUsernames={typingUsers[activeChat?.id ?? ''] ?? []}
            presence={presence}
            readCutoffs={readCutoffs}
            composerLocked={composerLocked}
            onLoadOlder={() => void handleLoadOlder()}
            onSend={handleSend}
            onTyping={handleTyping}
            onRead={handleRead}
            onManageGroup={activeChat?.type === 'GROUP' ? () => setManageChatId(activeChat.id) : undefined}
          />
        </div>
      </main>

      {newChatOpen && (
        <NewChatDialog
          onClose={() => setNewChatOpen(false)}
          onStartChat={(t) => void handleStartChat(t)}
          onCreateGroup={(name, userIds) => void handleCreateGroup(name, userIds)}
        />
      )}

      {manageChat && (
        <GroupManageDialog
          chat={manageChat}
          meId={user.id}
          onClose={() => setManageChatId(null)}
          onChanged={(chatId, opts) => void handleGroupChanged(chatId, opts)}
        />
      )}
    </div>
  );
}
