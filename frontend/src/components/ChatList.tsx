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
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 text-sm font-extrabold text-white shadow-md shadow-wizard-green-500/25 ring-1 ring-white/10">
            W
          </div>
          <h2 className="font-semibold tracking-tight">
            <span className="wizard-grad-text">WizardChat</span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-lg bg-gradient-to-b from-wizard-green-600 to-wizard-green-700 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-wizard-green-600/25 transition hover:brightness-110 active:scale-[0.98]"
        >
          + New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {chats.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-wizard-green-500/25 to-wizard-green-700/25 text-xl font-extrabold text-wizard-green-500 ring-1 ring-white/10">
              W
            </div>
            <p className="mt-3 text-sm text-wizard-muted">
              No chats yet. Start one with the button above.
            </p>
          </div>
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
                className={`flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition ${
                  active
                    ? 'border-wizard-green-500 bg-gradient-to-r from-wizard-hover/80 to-wizard-hover/30'
                    : 'border-transparent hover:bg-wizard-hover/50'
                }`}
              >
                <Avatar url={avatarUrl} name={avatarName} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate ${active ? 'font-semibold' : 'font-medium'}`}>{chatTitle(chat)}</span>
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
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-wizard-green-500 to-wizard-green-600 px-1.5 text-xs font-bold text-white shadow-sm shadow-wizard-green-500/40">
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
