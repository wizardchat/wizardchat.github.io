import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import {
  adminClearUserMessages,
  adminDeleteUser,
  adminDeleteUserMessage,
  adminListUserMessages,
  adminListUsers,
  adminResetPassword,
  adminUpdateUser,
} from '../lib/chatApi';
import type { AdminUser, AdminUserMessage } from '../lib/types';

const PAGE_SIZE = 25;

function Avatar({ user, size = 'h-9 w-9', text = 'text-sm' }: { user: AdminUser; size?: string; text?: string }) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.username}
        className={`${size} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <div
      className={`${size} flex shrink-0 items-center justify-center rounded-full bg-wizard-green-600 font-bold text-white uppercase ${text}`}
    >
      {user.username.slice(0, 2)}
    </div>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'muted'; children: ReactNode }) {
  const tones = {
    green: 'bg-wizard-green-500/20 text-wizard-green-500',
    amber: 'bg-amber-500/20 text-amber-400',
    red: 'bg-red-500/20 text-red-400',
    muted: 'bg-white/10 text-wizard-muted',
  };
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function MessageRow({ message, onDelete }: { message: AdminUserMessage; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs">
          {message.isE2ee ? (
            <span className="text-wizard-muted">End-to-end encrypted (not visible to admins)</span>
          ) : (
            <span className="text-wizard-muted">{message.preview ?? '—'}</span>
          )}
        </p>
        <p className="mt-0.5 text-[10px] text-wizard-muted">
          {new Date(message.createdAt).toLocaleString()} · chat {message.chatId.slice(0, 8)}…
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onDelete()}
        className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400"
      >
        Delete
      </button>
    </div>
  );
}

function UserMessages({ userId, onError }: { userId: string; onError: (msg: string) => void }) {
  const [messages, setMessages] = useState<AdminUserMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setMessages(await adminListUserMessages(userId));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load messages');
      setMessages(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function deleteOne(messageId: string) {
    try {
      await adminDeleteUserMessage(userId, messageId);
      setMessages((prev) => prev?.filter((m) => m.id !== messageId) ?? prev);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete ALL messages from this user across every chat?')) return;
    try {
      const deleted = await adminClearUserMessages(userId);
      setMessages([]);
      onError(`Deleted ${deleted} message${deleted === 1 ? '' : 's'}`);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Clear failed');
    }
  }

  if (loading && !messages) {
    return <p className="px-3 py-2 text-sm text-wizard-muted">Loading messages…</p>;
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/5 bg-wizard-bubble-in/60 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-wizard-muted">
          {messages?.length ?? 0} latest message{messages?.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          onClick={() => void clearAll()}
          className="rounded-md border border-white/10 px-2 py-1 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400"
        >
          Clear all messages
        </button>
      </div>
      {messages && messages.length === 0 ? (
        <p className="text-sm text-wizard-muted">No messages.</p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {messages?.map((m) => (
            <MessageRow key={m.id} message={m} onDelete={() => deleteOne(m.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const { user, loading } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [messagesFor, setMessagesFor] = useState<string | null>(null);

  const show = useCallback((text: string, kind: 'ok' | 'err' | 'info' = 'ok') => {
    setNotice({ kind, text });
  }, []);

  const load = useCallback(
    async (nextOffset = offset, q = query, silent = false) => {
      setBusy(true);
      try {
        const data = await adminListUsers(q, PAGE_SIZE, nextOffset);
        if (silent && data.users.length === 0 && data.total > 0) {
          // Never blank the table just because a paginated search missed on a
          // background refresh — keep whatever we have on screen.
          setBusy(false);
          return;
        }
        setUsers(data.users);
        setTotal(data.total);
        setOffset(nextOffset);
      } catch (err) {
        if (!silent) show(err instanceof Error ? err.message : 'Failed to load users', 'err');
      } finally {
        setBusy(false);
      }
    },
    [offset, query, show],
  );

  // Silent auto-refresh while the tab is open and focused, so actions taken by
  // other admins (or elsewhere) show up without a manual reload.
  const busyRef = useRef(false);
  const loadRef = useRef(load);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (busyRef.current || !document.hasFocus()) return;
      loadRef.current(offset, query, true);
    }, 15000);
    return () => window.clearInterval(id);
  }, [offset, query]);

  useEffect(() => {
    void load(0, '');
  }, []);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    await load(0, query);
  }

  async function runAction(action: () => Promise<unknown>, okText: string) {
    try {
      await action();
      show(okText);
      await load(offset, query);
      if (messagesFor) setMessagesFor(null);
    } catch (err) {
      show(err instanceof Error ? err.message : 'Action failed', 'err');
    }
  }

  async function toggleBan(u: AdminUser) {
    await runAction(
      () => adminUpdateUser(u.id, { banned: !u.banned }),
      u.banned ? `${u.username} unblocked` : `${u.username} blocked`,
    );
  }

  async function toggleRole(u: AdminUser) {
    const demote = u.role === 'ADMIN';
    if (demote && !window.confirm(`Demote ${u.username} from admin?`)) return;
    await runAction(
      () => adminUpdateUser(u.id, { role: demote ? 'USER' : 'ADMIN' }),
      demote ? `${u.username} is now a regular user` : `${u.username} is now an admin`,
    );
  }

  async function resetPassword(u: AdminUser) {
    if (!window.confirm(`Reset password for ${u.username}? This signs them out everywhere and clears their E2EE keys.`)) {
      return;
    }
    try {
      const result = await adminResetPassword(u.id);
      show(`New password for ${u.username}: ${result.tempPassword}`, 'info');
      await load(offset, query);
    } catch (err) {
      show(err instanceof Error ? err.message : 'Reset failed', 'err');
    }
  }

  async function deleteUser(u: AdminUser) {
    if (!window.confirm(`DELETE ${u.username}? This permanently removes their account, chats, and messages.`)) {
      return;
    }
    try {
      await adminDeleteUser(u.id);
      show(`Deleted ${u.username}`);
      await load(offset, query);
      if (messagesFor === u.id) setMessagesFor(null);
    } catch (err) {
      show(err instanceof Error ? err.message : 'Delete failed', 'err');
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-wizard-green-500 border-t-transparent" />
      </div>
    );
  }

  if (!user || user.role !== 'ADMIN') {
    return <Navigate to="/" replace />;
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin panel</h1>
          <p className="text-sm text-wizard-muted">Users, moderation, and resets — {total} account{total === 1 ? '' : 's'} total</p>
        </div>
        <Link to="/" className="rounded-xl border border-white/10 px-4 py-2 text-sm text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text">
          Back to chats →
        </Link>
      </header>

      {notice && (
        <p
          role="status"
          className={`mt-4 rounded-lg px-3 py-2 text-sm break-all ${
            notice.kind === 'ok' ? 'bg-wizard-green-500/10 text-wizard-green-500'
            : notice.kind === 'err' ? 'bg-red-500/10 text-red-400'
            : 'bg-amber-500/10 text-amber-400'
          }`}
        >
          {notice.text}
        </p>
      )}

      <form onSubmit={handleSearch} className="mt-6 flex gap-2">
        <input
          type="search"
          placeholder="Search by username or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)]"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-xl bg-wizard-green-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-50"
        >
          Search
        </button>
      </form>

      <div className="mt-4 space-y-2">
        {users === null ? (
          <p className="text-sm text-wizard-muted">Loading users…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-wizard-muted">No users match that search.</p>
        ) : (
          users.map((u) => (
            <div key={u.id} className="wizard-surface rounded-2xl border border-white/10 p-4 shadow-xl shadow-black/30">
              <div className="flex flex-wrap items-center gap-3">
                <Avatar user={u} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{u.username}</span>
                    {u.role === 'ADMIN' && <Badge tone="amber">admin</Badge>}
                    {u.banned && <Badge tone="red">blocked</Badge>}
                    {u.id === user.id && <Badge tone="muted">you</Badge>}
                  </div>
                  <p className="truncate text-sm text-wizard-muted">
                    {u.email ?? 'no email'} · {u.messageCount} messages · {u.activeSessions} active session{u.activeSessions === 1 ? '' : 's'} · joined {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void toggleBan(u)}
                    disabled={u.id === user.id}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text disabled:opacity-40"
                  >
                    {u.banned ? 'Unblock' : 'Block'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleRole(u)}
                    disabled={u.id === user.id}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-wizard-muted transition hover:border-amber-400 hover:text-amber-400 disabled:opacity-40"
                  >
                    {u.role === 'ADMIN' ? 'Demote' : 'Make admin'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetPassword(u)}
                    disabled={u.id === user.id}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text disabled:opacity-40"
                  >
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessagesFor(messagesFor === u.id ? null : u.id)}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text"
                  >
                    {messagesFor === u.id ? 'Hide messages' : 'Messages'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteUser(u)}
                    disabled={u.id === user.id}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {messagesFor === u.id && (
                <div className="mt-3">
                  <UserMessages userId={u.id} onError={(msg) => show(msg, 'err')} />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="mt-6 flex items-center justify-center gap-3 text-sm text-wizard-muted">
        <button
          type="button"
          disabled={offset === 0 || busy}
          onClick={() => void load(offset - PAGE_SIZE, query)}
          className="rounded-lg border border-white/10 px-3 py-1.5 transition hover:border-wizard-green-500 disabled:opacity-40"
        >
          ← Prev
        </button>
        <span>
          page {page} of {pageCount}
        </span>
        <button
          type="button"
          disabled={offset + PAGE_SIZE >= total || busy}
          onClick={() => void load(offset + PAGE_SIZE, query)}
          className="rounded-lg border border-white/10 px-3 py-1.5 transition hover:border-wizard-green-500 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}