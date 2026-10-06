import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { uploadAttachment } from '../lib/upload';
import { describeAttachment } from '../lib/chatApi';
import type { Attachment, ChatListItem, ChatMessage } from '../lib/types';
import Avatar from './Avatar';

interface Props {
  chat: ChatListItem | null;
  meId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  loadingHistory: boolean;
  typingUsernames: string[];
  presence: Record<string, boolean>;
  readCutoffs: Record<string, string>;
  composerLocked?: boolean;
  onLoadOlder: () => void;
  onSend: (content: string, attachment?: Attachment) => Promise<void>;
  onTyping: (isTyping: boolean) => void;
  onRead: () => void;
  onManageGroup?: () => void;
}

function ticksFor(message: ChatMessage, props: Props): ReactNode {
  if (message.senderId !== props.meId) return null;

  const others = props.chat?.members.filter((m) => m.userId !== props.meId) ?? [];
  const readByOther = others.some((other) => {
    const cutoff = props.readCutoffs[other.userId];
    return cutoff && message.createdAt <= cutoff;
  });
  const delivered = others.some((other) => props.presence[other.userId]);

  if (message.status === 'pending') {
    return <span className="text-xs text-wizard-muted">🕓</span>;
  }
  if (message.status === 'failed') {
    return <span className="text-xs text-red-400">⚠</span>;
  }
  if (readByOther) {
    return <span className="text-xs font-bold text-sky-400">✓✓</span>;
  }
  if (delivered) {
    return <span className="text-xs text-wizard-muted">✓✓</span>;
  }
  return <span className="text-xs text-wizard-muted">✓</span>;
}

function AttachmentCard({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const href = attachment.url;
  const content = (
    <div className={mine ? 'text-white' : 'text-wizard-text'}>
      {attachment.resourceType === 'image' ? (
        <img
          src={attachment.url}
          alt={attachment.name ?? 'image'}
          loading="lazy"
          className="rounded-lg"
          style={{ maxHeight: 288 }}
        />
      ) : attachment.resourceType === 'video' ? (
        <video src={attachment.url} controls className="rounded-lg" style={{ maxHeight: 288 }} />
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <span className="text-xl">📎</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{attachment.name ?? 'File'}</span>
            {attachment.size > 0 && (
              <span className="text-xs opacity-70">
                {(attachment.size / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );

  const inner =
    attachment.resourceType === 'raw' ? (
      content
    ) : (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {content}
      </a>
    );

  return <div className="mb-1 overflow-hidden rounded-lg">{inner}</div>;
}

export default function Conversation(props: Props) {
  const { chat, messages } = props;
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const lastReadChatRef = useRef<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, chat?.id]);

  // Clear pending attachment state when switching chats.
  useEffect(() => {
    setAttachment(null);
    setAttaching(false);
    setAttachError(null);
    setDraft('');
  }, [chat?.id]);

  useEffect(() => {
    if (!chat) return;
    if (lastReadChatRef.current !== chat.id) {
      lastReadChatRef.current = chat.id;
    }
    if (messages.length > 0) {
      props.onRead();
    }
  }, [chat?.id, messages.length]);

  if (!chat) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-wizard-muted">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-wizard-green-700 text-3xl font-bold text-white">
          W
        </div>
        <p className="text-sm">Select a chat to start messaging</p>
      </div>
    );
  }

  const title = chat.name ?? 'Unknown';
  const other = chat.members.find((m) => m.userId !== props.meId);
  const online = other ? props.presence[other.userId] : false;
  const headerAvatarUrl = chat.type === 'GROUP' ? chat.avatarUrl : other?.avatarUrl ?? null;
  const headerAvatarName = chat.type === 'GROUP' ? title : other?.username ?? null;
  const groupOnline = chat.type === 'GROUP' ? chat.members.filter((m) => props.presence[m.userId]).length : 0;
  const subtitle =
    props.typingUsernames.length > 0
      ? `${props.typingUsernames.join(', ')} typing…`
      : chat.type === 'GROUP'
        ? `${chat.members.length} members${groupOnline > 0 ? ` · ${groupOnline} online` : ''}`
        : online
          ? 'online'
          : 'offline';
  const isGroup = chat.type === 'GROUP';

  function handleTypingChange(value: string) {
    setDraft(value);
    props.onTyping(value.length > 0);
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      props.onTyping(false);
    }, 2000);
  }

  function handlePickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAttachError(null);
    setAttaching(true);
    uploadAttachment(file)
      .then((result) => setAttachment(result))
      .catch((err: unknown) => {
        setAttachment(null);
        setAttachError(err instanceof Error ? err.message : 'Upload failed');
      })
      .finally(() => setAttaching(false));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (props.composerLocked || attaching) return;
    const content = draft.trim();
    if (!content && !attachment) return;
    const sentAttachment = attachment;
    setDraft('');
    setAttachment(null);
    setAttachError(null);
    props.onTyping(false);
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    await props.onSend(content, sentAttachment ?? undefined);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as FormEvent);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/5 bg-wizard-panel px-4 py-3">
        <Avatar url={headerAvatarUrl} name={headerAvatarName} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{title}</h3>
          <p className="text-xs text-wizard-muted">{subtitle}</p>
        </div>
        {isGroup && props.onManageGroup && (
          <button
            type="button"
            onClick={props.onManageGroup}
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-lg leading-none text-wizard-muted transition hover:bg-wizard-hover hover:text-wizard-text"
            aria-label="Group settings"
            title="Group settings"
          >
            ⚙
          </button>
        )}
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {props.hasMore && (
          <div className="text-center">
            <button
              type="button"
              onClick={props.onLoadOlder}
              disabled={props.loadingHistory}
              className="rounded-full border border-white/10 px-4 py-1 text-xs text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text disabled:opacity-50"
            >
              {props.loadingHistory ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}

        {messages.map((message) => {
          const mine = message.senderId === props.meId;
          return (
            <div key={message.tempId ?? message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] rounded-xl px-3 py-2 text-sm shadow ${
                  mine ? 'bg-wizard-bubble-out text-white' : 'bg-wizard-bubble-in text-wizard-text'
                } ${message.status === 'pending' ? 'opacity-70' : ''} ${
                  message.status === 'failed' ? 'ring-1 ring-red-400/60' : ''
                }`}
              >
                {!mine && (
                  <p className="mb-0.5 text-xs font-semibold text-wizard-green-500">
                    {message.sender.username}
                  </p>
                )}
                {message.attachment && <AttachmentCard attachment={message.attachment} mine={mine} />}
                {message.content && <p className="whitespace-pre-wrap break-words">{message.content}</p>}
                <div
                  className={`mt-1 flex items-center gap-1 text-[10px] ${
                    mine ? 'justify-end text-white/70' : 'text-wizard-muted'
                  }`}
                >
                  <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {ticksFor(message, props)}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-white/5 bg-wizard-panel p-3">
        {attachError && <p className="mb-2 text-xs text-red-400">{attachError}</p>}
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-wizard-bubble-in p-2">
            <div className="flex items-center gap-2 overflow-hidden">
              {attachment.resourceType === 'image' && (
                <img src={attachment.url} alt={attachment.name ?? 'preview'} className="h-12 w-12 rounded-md object-cover" />
              )}
              {attachment.resourceType === 'video' && <span className="text-xl">🎬</span>}
              {attachment.resourceType === 'raw' && <span className="text-xl">📎</span>}
              <span className="max-w-[16rem] truncate text-sm text-wizard-text">
                {describeAttachment(attachment)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              className="ml-auto shrink-0 rounded-md px-2 py-1 text-sm text-wizard-muted transition hover:bg-wizard-hover hover:text-wizard-text"
              aria-label="Remove attachment"
              title="Remove attachment"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={props.composerLocked || attaching}
            className="shrink-0 rounded-xl border border-white/10 bg-wizard-bubble-in px-3 py-2.5 text-lg leading-none text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Attach a file"
            title="Attach a file"
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handlePickFile}
            accept="image/*,video/*,application/pdf,text/plain,.csv,.zip"
            data-testid="attachment-input"
          />
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => handleTypingChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={props.composerLocked ? 'Unlock with your password to send encrypted messages' : 'Type a message'}
            maxLength={4000}
            disabled={props.composerLocked}
            className="max-h-32 flex-1 resize-none rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={attaching || (!draft.trim() && !attachment) || props.composerLocked}
            className="rounded-xl bg-wizard-green-600 px-4 py-2.5 font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-40"
          >
            {attaching ? 'Uploading…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}