import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { uploadAttachment } from '../lib/upload';
import { reassembleAttachment } from '../lib/reassemble';
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
  onBack?: () => void;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function SplitFileCard({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const [status, setStatus] = useState<
    | { phase: 'idle' }
    | { phase: 'downloading'; percent: number }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  async function download() {
    if (status.phase === 'downloading') return;
    setStatus({ phase: 'downloading', percent: 0 });
    try {
      await reassembleAttachment(attachment, (received, total) => {
        setStatus({ phase: 'downloading', percent: total > 0 ? Math.round((received / total) * 100) : 0 });
      });
      setStatus({ phase: 'idle' });
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : 'Could not reassemble file' });
    }
  }

  const partCount = attachment.parts?.length ?? 0;

  return (
    <div className="mb-1 overflow-hidden rounded-lg">
      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <div className={`flex items-center gap-2 ${mine ? 'text-white' : 'text-wizard-text'}`}>
          <span className="text-xl">📎</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{attachment.name ?? 'File'}</span>
            <span className="text-xs opacity-70">
              {formatBytes(attachment.size)}
              {partCount > 1 ? ` · ${partCount} parts` : ''}
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => void download()}
          disabled={status.phase === 'downloading'}
          className="mt-2 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.phase === 'downloading'
            ? `Combining… ${status.percent}%`
            : status.phase === 'error'
              ? 'Try download again'
              : 'Download combined file'}
        </button>
        {status.phase === 'error' && (
          <p className="mt-1 text-xs text-red-400">{status.message}</p>
        )}
      </div>
    </div>
  );
}

function AttachmentCard({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const isSplit = (attachment.parts?.length ?? 0) >= 2;
  if (isSplit) return <SplitFileCard attachment={attachment} mine={mine} />;

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
              <span className="text-xs opacity-70">{formatBytes(attachment.size)}</span>
            )}
          </span>
        </div>
      )}
    </div>
  );

  const inner = (
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
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [failedFile, setFailedFile] = useState<File | null>(null);
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
    setFailedFile(null);
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
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-wizard-muted">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 text-4xl font-extrabold text-white shadow-2xl shadow-wizard-green-600/30 ring-1 ring-white/10">
          W
        </div>
        <div>
          <p className="text-base font-semibold text-wizard-text">Your conversations live here</p>
          <p className="mt-1 text-sm">Select a chat from the list to start messaging</p>
        </div>
      </div>
    );
  }

  const title = chat.name ?? 'Unknown';
  const other = chat.members.find((m) => m.userId !== props.meId);
  const online = other ? props.presence[other.userId] : false;
  const headerAvatarUrl = chat.type === 'GROUP' ? chat.avatarUrl : other?.avatarUrl ?? null;
  const headerAvatarName = chat.type === 'GROUP' ? title : other?.username ?? null;
  const groupOnline = chat.type === 'GROUP' ? chat.members.filter((m) => props.presence[m.userId]).length : 0;
  const subtitle = props.typingUsernames.length > 0 ? `${props.typingUsernames.join(', ')} typing…` : chat.type === 'GROUP' ? `${chat.members.length} members${groupOnline > 0 ? ` · ${groupOnline} online` : ''}` : online ? 'online' : 'offline';
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

  function startUpload(file: File) {
    setAttachError(null);
    setFailedFile(null);
    setAttaching(true);
    setUploadProgress(0);
    uploadAttachment(file, (uploaded, total) => {
      setUploadProgress(total > 0 ? Math.round((uploaded / total) * 100) : null);
    })
      .then((result) => {
        setAttachment(result);
        setAttachError(null);
      })
      .catch((err: unknown) => {
        setAttachment(null);
        setFailedFile(file);
        setAttachError(err instanceof Error ? err.message : 'Upload failed');
      })
      .finally(() => {
        setAttaching(false);
        setUploadProgress(null);
      });
  }

  function handlePickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    startUpload(file);
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

  const subtitleNode = props.typingUsernames.length > 0 ? (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5">
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-wizard-green-500" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-wizard-green-500" style={{ animationDelay: '0.15s' }} />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-wizard-green-500" style={{ animationDelay: '0.3s' }} />
      </span>
      {props.typingUsernames.join(', ')}
    </span>
  ) : chat.type === 'GROUP' ? (
    subtitle
  ) : online ? (
    <span className="flex items-center gap-1.5">
      <span className="live-dot h-2 w-2 rounded-full bg-wizard-green-500" />
      online
    </span>
  ) : (
    subtitle
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-white/5 bg-wizard-panel/70 px-3 py-3 backdrop-blur-xl sm:gap-3 sm:px-4">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            className="shrink-0 rounded-lg px-2 py-1.5 text-lg leading-none text-wizard-muted transition hover:bg-wizard-hover hover:text-wizard-text md:hidden"
            aria-label="Back to chats"
            title="Back to chats"
          >
            ←
          </button>
        )}
        <Avatar url={headerAvatarUrl} name={headerAvatarName} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{title}</h3>
          <p className="text-xs text-wizard-muted">{subtitleNode}</p>
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
          const failed = message.status === 'failed';
          const pending = message.status === 'pending';
          return (
            <div key={message.tempId ?? message.id} className={`animate-message-in flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-lg shadow-black/20 ${
                  mine
                    ? 'rounded-tr-md bg-gradient-to-br from-wizard-bubble-out to-wizard-green-600 text-white'
                    : 'rounded-tl-md bg-wizard-bubble-in text-wizard-text ring-1 ring-white/5'
                } ${pending ? 'opacity-70' : ''} ${failed ? 'ring-1 ring-red-400/60' : ''}`}
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

      <form onSubmit={handleSubmit} className="border-t border-white/5 bg-wizard-panel/70 p-3 backdrop-blur-xl">
        {attachError && (
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-red-400">
            <span className="min-w-0">{attachError}</span>
            {failedFile && (
              <button
                type="button"
                onClick={() => startUpload(failedFile)}
                disabled={attaching}
                className="shrink-0 rounded-md border border-red-400/40 px-2 py-1 font-semibold transition hover:bg-red-400/10 disabled:opacity-40"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 p-2">
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
            className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-lg leading-none text-wizard-muted transition hover:border-wizard-green-500 hover:bg-white/10 hover:text-wizard-text disabled:cursor-not-allowed disabled:opacity-40"
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
            accept="*/*"
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
            className="max-h-32 flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)] disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={attaching || (!draft.trim() && !attachment) || props.composerLocked}
            className="rounded-xl bg-gradient-to-b from-wizard-green-600 to-wizard-green-700 px-4 py-2.5 font-semibold text-white shadow-lg shadow-wizard-green-600/25 transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
          >
            {attaching
              ? uploadProgress !== null
                ? `Uploading ${uploadProgress}%…`
                : 'Uploading…'
              : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}