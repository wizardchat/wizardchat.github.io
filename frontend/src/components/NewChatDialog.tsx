import { useEffect, useRef, useState } from 'react';
import { searchUsers } from '../lib/chatApi';

interface Props {
  onClose: () => void;
  onStartChat: (target: { userId: string; username: string }) => void;
  onCreateGroup: (name: string, userIds: string[]) => void;
}

type Tab = 'direct' | 'group';

interface SearchUser {
  id: string;
  username: string;
}

export default function NewChatDialog({ onClose, onStartChat, onCreateGroup }: Props) {
  const [tab, setTab] = useState<Tab>('direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selected, setSelected] = useState<SearchUser[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchUsers(q)
        .then((users) => {
          if (!cancelled) setResults(users);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function pickUser(user: SearchUser) {
    if (tab === 'direct') {
      onStartChat({ userId: user.id, username: user.username });
      return;
    }
    setSelected((prev) => (prev.some((x) => x.id === user.id) ? prev : [...prev, user]));
  }

  const remaining = query.trim() ? results.filter((u) => !selected.some((x) => x.id === u.id)) : results;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-wizard-panel p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New chat"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New chat</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-wizard-muted transition hover:text-wizard-text"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex rounded-xl border border-white/10 bg-wizard-bubble-in p-1">
          <button
            type="button"
            onClick={() => setTab('direct')}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              tab === 'direct' ? 'bg-wizard-green-600 text-white' : 'text-wizard-muted hover:text-wizard-text'
            }`}
          >
            1-on-1
          </button>
          <button
            type="button"
            onClick={() => setTab('group')}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              tab === 'group' ? 'bg-wizard-green-600 text-white' : 'text-wizard-muted hover:text-wizard-text'
            }`}
          >
            Group
          </button>
        </div>

        {tab === 'group' && (
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name"
            maxLength={50}
            className="mt-4 w-full rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500"
          />
        )}

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'group' ? 'Search people to add…' : 'Search username…'}
          className="mt-4 w-full rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500"
        />

        {selected.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelected((prev) => prev.filter((x) => x.id !== user.id))}
                className="flex items-center gap-1.5 rounded-full bg-wizard-green-700 px-3 py-1 text-xs font-medium text-white"
              >
                {user.username} <span className="text-white/50">✕</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 max-h-64 overflow-y-auto">
          {searching && <p className="text-sm text-wizard-muted">Searching…</p>}
          {!searching && query.trim() && remaining.length === 0 && (
            <p className="text-sm text-wizard-muted">No users found</p>
          )}
          {remaining.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => pickUser(user)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-wizard-hover"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-wizard-green-700 text-sm font-bold uppercase">
                {user.username.slice(0, 2)}
              </div>
              <span className="font-medium">{user.username}</span>
            </button>
          ))}
        </div>

        {tab === 'group' && (
          <button
            type="button"
            disabled={!groupName.trim()}
            onClick={() => onCreateGroup(groupName.trim(), selected.map((s) => s.id))}
            className="mt-4 w-full rounded-xl bg-wizard-green-600 px-4 py-2.5 font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-40"
          >
            Create group{selected.length > 0 ? ` with ${selected.length} more` : ''}
          </button>
        )}
      </div>
    </div>
  );
}