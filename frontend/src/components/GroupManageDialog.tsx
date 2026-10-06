import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addGroupMembers,
  fetchChat,
  leaveGroup,
  removeGroupMember,
  renameGroup,
  searchUsers,
  setGroupMemberRole,
  updateChatSettings,
} from '../lib/chatApi';
import { uploadAttachment } from '../lib/upload';
import type { ChatListItem, ChatMemberInfo, ChatRole } from '../lib/types';
import Avatar from './Avatar';

interface Props {
  chat: ChatListItem;
  meId: string;
  onClose: () => void;
  onChanged: (chatId: string, opts?: { left?: boolean }) => void;
}

interface SearchUser {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export default function GroupManageDialog({ chat, meId, onClose, onChanged }: Props) {
  const [name, setName] = useState(chat.name ?? '');
  const [savedName, setSavedName] = useState(chat.name ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(chat.avatarUrl ?? null);
  const [members, setMembers] = useState<ChatMemberInfo[]>(chat.members ?? []);
  const [myRole, setMyRole] = useState<ChatRole | null>(chat.myRole ?? null);
  const [busy, setBusy] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<SearchUser[]>([]);
  const [addSearching, setAddSearching] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'remove' | 'promote' | 'demote' | 'rename'; userId?: string } | null>(
    null,
  );
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  const refresh = useCallback(async () => {
    const fresh = await fetchChat(chat.id);
    setName(fresh.name ?? '');
    setSavedName(fresh.name ?? '');
    setAvatarUrl(fresh.avatarUrl ?? null);
    setMembers(fresh.members);
    setMyRole(fresh.myRole);
  }, [chat.id]);

  useEffect(() => {
    addInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = addQuery.trim();
    if (q.length < 1) {
      setAddResults([]);
      return;
    }
    let cancelled = false;
    setAddSearching(true);
    const timer = window.setTimeout(() => {
      void searchUsers(q)
        .then((users) => {
          if (!cancelled) setAddResults(users);
        })
        .catch(() => {
          if (!cancelled) setAddResults([]);
        })
        .finally(() => {
          if (!cancelled) setAddSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addQuery]);

  async function run(action: () => Promise<unknown>, notify = true) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (notify) onChanged(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(userId: string) {
    await run(async () => {
      await addGroupMembers(chat.id, [userId]);
      await refresh();
      setAddQuery('');
      setAddResults([]);
    }, false);
    onChanged(chat.id);
  }

  async function handleRemove(userId: string) {
    setConfirm(null);
    await run(async () => {
      await removeGroupMember(chat.id, userId);
      await refresh();
    });
  }

  async function handleRoleChange(userId: string, role: 'admin' | 'member') {
    setConfirm(null);
    await run(async () => {
      await setGroupMemberRole(chat.id, userId, role);
      await refresh();
    });
  }

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === savedName) return;
    setConfirm(null);
    await run(async () => {
      await renameGroup(chat.id, trimmed);
      await refresh();
    });
  }

  async function handleAvatarFile(file: File) {
    setAvatarUploading(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(file);
      const updated = await updateChatSettings(chat.id, { avatarUrl: attachment.url });
      setAvatarUrl(updated.avatarUrl ?? null);
      onChanged(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update group picture');
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleRemovePicture() {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateChatSettings(chat.id, { avatarUrl: null });
      setAvatarUrl(updated.avatarUrl ?? null);
      onChanged(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove group picture');
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    setConfirmLeave(false);
    setBusy(true);
    setError(null);
    try {
      await leaveGroup(chat.id);
      onChanged(chat.id, { left: true });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave group');
      setBusy(false);
    }
  }

  function canRemove(member: ChatMemberInfo): boolean {
    if (member.userId === meId) return false;
    if (isOwner) return true;
    if (myRole === 'admin') return member.role === 'member';
    return false;
  }

  function canChangeRole(member: ChatMemberInfo): boolean {
    if (!isOwner) return false;
    return member.userId !== meId && member.role !== 'owner';
  }

  function roleLabel(role: ChatRole): string {
    return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
  }

  const candidates = addResults.filter((u) => !members.some((m) => m.userId === u.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="wizard-surface flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-white/10 p-6 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Group settings"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Group settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-wizard-muted transition hover:text-wizard-text"
          >
            ✕
          </button>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}

        <div className="mt-4 flex items-center gap-3">
          {canManage && (
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
          )}
          <Avatar url={avatarUrl} name={name} size={56} />
          {canManage && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || avatarUploading}
                onClick={() => avatarInputRef.current?.click()}
                className="rounded-xl border border-white/10 px-3 py-1.5 text-xs text-wizard-muted transition hover:text-wizard-text disabled:opacity-40"
              >
                {avatarUploading ? 'Uploading…' : avatarUrl ? 'Change picture' : 'Set picture'}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  disabled={busy || avatarUploading}
                  onClick={() => void handleRemovePicture()}
                  className="rounded-xl border border-white/10 px-3 py-1.5 text-xs text-wizard-muted transition hover:border-red-400/50 hover:text-red-400 disabled:opacity-40"
                >
                  Remove picture
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            disabled={!canManage || busy}
            placeholder="Group name"
            className="flex-1 rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500 disabled:opacity-50"
          />
          {canManage && name.trim() !== savedName && (
            <button
              type="button"
              onClick={() => void handleRename()}
              disabled={busy || !name.trim()}
              className="rounded-xl bg-wizard-green-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-40"
            >
              Rename
            </button>
          )}
        </div>

        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-wizard-muted">
          {members.length} member{members.length === 1 ? '' : 's'}
        </p>

        <div className="mt-2 flex-1 overflow-y-auto">
          {members.map((member) => {
            const isMe = member.userId === meId;
            return (
              <div
                key={member.userId}
                className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-wizard-hover/50"
              >
                <Avatar url={member.avatarUrl} name={member.username} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.username}
                    {isMe && <span className="text-wizard-muted"> (you)</span>}
                  </p>
                  <p className="text-xs text-wizard-muted">{roleLabel(member.role)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canChangeRole(member) && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRoleChange(member.userId, member.role === 'admin' ? 'member' : 'admin')}
                        className="rounded-lg border border-white/10 px-2 py-1 text-xs text-wizard-muted transition hover:text-wizard-text disabled:opacity-40"
                      >
                        {member.role === 'admin' ? 'Demote' : 'Make admin'}
                      </button>
                    </>
                  )}
                  {canRemove(member) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        confirm?.kind === 'remove' && confirm.userId === member.userId
                          ? void handleRemove(member.userId)
                          : setConfirm({ kind: 'remove', userId: member.userId })
                      }
                      className="rounded-lg border border-red-400/40 px-2 py-1 text-xs text-red-400 transition hover:bg-red-500/10 disabled:opacity-40"
                    >
                      {confirm?.kind === 'remove' && confirm.userId === member.userId ? 'Confirm' : 'Remove'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {canManage && (
          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="flex items-center gap-2">
              <input
                ref={addInputRef}
                type="text"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="Add people by username…"
                className="flex-1 rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2 text-sm text-wizard-text outline-none transition focus:border-wizard-green-500"
              />
            </div>
            {addSearching && <p className="mt-2 text-sm text-wizard-muted">Searching…</p>}
            {!addSearching && addQuery.trim() && candidates.length === 0 && (
              <p className="mt-2 text-sm text-wizard-muted">No users found</p>
            )}
            <div className="mt-2 max-h-36 overflow-y-auto">
              {candidates.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAdd(user.id)}
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-wizard-hover disabled:opacity-40"
                >
                  <Avatar url={user.avatarUrl ?? null} name={user.username} size={32} />
                  <span className="text-sm font-medium">{user.username}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-4">
          {confirmLeave ? (
            <button
              type="button"
              onClick={() => void handleLeave()}
              disabled={busy}
              className="rounded-xl bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/30 disabled:opacity-40"
            >
              Confirm leave
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              className="rounded-xl border border-red-400/40 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/10"
            >
              {isOwner ? 'Leave group (owner transfers)' : 'Leave group'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 px-4 py-2 text-sm text-wizard-muted transition hover:text-wizard-text"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}