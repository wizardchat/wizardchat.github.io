import type { ChatListItem } from '../lib/types';
import Avatar from './Avatar';

interface Props {
  chats: ChatListItem[];
  activeChatId: string | null;
  meId: string;
  onSelect: (chat: ChatListItem) => void;
  onNewChat: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function chatTitle(chat: ChatListItem): string {
  return chat.name ?? 'Unknown';
}

function attachmentLabel(kind: 'image' | 'video' | 'file', name: string): string {
  const icon = kind === 'image' ? '📷' : kind === 'video' ? '🎬' : '📎';
  return `${icon} ${name}`;
}

export default function ChatList({ chats, activeChatId, meId, onSelect, onNewChat }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <h2 className="font-semibold">Chats</h2>
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-lg bg-wizard-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-wizard-green-700"
        >
          + New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {chats.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-wizard-muted">
            No chats yet. Start one with the button above.
          </p>
        ) : (
          chats.map((chat) => {
            const active = chat.id === activeChatId;
            const other = chat.members.find((m) => m.userId !== meId);
            const avatarUrl = chat.type === 'GROUP' ? chat.avatarUrl : other?.avatarUrl ?? null;
            const avatarName = chat.type === 'GROUP' ? chatTitle(chat) : other?.username ?? null;
            const previewSender =
              chat.lastMessage?.senderId === meId ? 'You: ' : other ? `${other.username}: ` : '';
            const preview =
              chat.lastMessage?.attachment && !chat.lastMessage.content
                ? attachmentLabel(chat.lastMessage.attachment.kind, chat.lastMessage.attachment.name)
                : chat.lastMessage?.content ?? 'No messages yet';
            return (
              <button
                key={chat.id}
                type="button"
                onClick={() => onSelect(chat)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                  active ? 'bg-wizard-hover' : 'hover:bg-wizard-hover/50'
                }`}
              >
                <Avatar url={avatarUrl} name={avatarName} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{chatTitle(chat)}</span>
                    <span className="shrink-0 text-xs text-wizard-muted">
                      {chat.lastMessage ? formatTime(chat.lastMessage.createdAt) : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-wizard-muted">
                      {previewSender}
                      {preview}
                    </span>
                    {chat.unreadCount > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wizard-green-500 px-1.5 text-xs font-bold text-white">
                        {chat.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
