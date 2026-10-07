import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import Avatar from '../components/Avatar';
import { useAuth } from '../lib/auth';
import { disablePush, enablePush, getPushPreference, isPushActive, pushSupported, setPushPreference } from '../lib/push';
import { uploadAttachment } from '../lib/upload';

type PushState = 'checking' | 'on' | 'off' | 'blocked' | 'unsupported';

async function resolvePushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!getPushPreference()) return 'off';
  if (Notification.permission === 'denied') return 'blocked';
  return (await isPushActive()) ? 'on' : 'off';
}

const inputClass =
  'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)]';

const cardClass = 'wizard-surface rounded-2xl border border-white/10 p-6 shadow-2xl shadow-black/40';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold uppercase tracking-wider text-wizard-muted">{children}</h2>;
}

export default function Settings() {
  const navigate = useNavigate();
  const { user, loading, logout, updateProfile, changePassword } = useAuth();

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolvePushState().then((state) => {
      if (!cancelled) setPushState(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleTogglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    const wasOn = pushState === 'on';
    try {
      if (wasOn) {
        setPushPreference(false);
        await disablePush();
      } else {
        setPushPreference(true);
        await enablePush();
        if (!(await isPushActive()) && Notification.permission === 'granted') {
          setPushError('Notifications could not be enabled in this browser. Check your site settings and try again.');
        }
      }
    } catch {
      setPushError('Could not update notifications right now.');
    } finally {
      setPushState(await resolvePushState());
      setPushBusy(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    setPwNotice(null);
    if (newPw !== confirmPw) {
      setPwError('New passwords do not match');
      return;
    }
    if (newPw.length < 8) {
      setPwError('Password must be at least 8 characters');
      return;
    }
    setPwSubmitting(true);
    try {
      await changePassword(curPw, newPw);
      setCurPw('');
      setNewPw('');
      setConfirmPw('');
      setPwNotice('Password updated. Your encrypted chat keys were re-wrapped.');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Could not change your password');
    } finally {
      setPwSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-wizard-green-500 border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return <NavigateToHome />;
  }

  const pushUnsupported = pushState === 'unsupported';
  const pushDisabled = pushUnsupported || pushBusy;
  const pushOn = pushState === 'on';

  return (
    <div className="min-h-screen px-4 py-8">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">
            Settings <span className="wizard-grad-text">⚙️</span>
          </h1>
          <Link
            to="/"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-wizard-muted transition hover:border-wizard-green-500/50 hover:text-wizard-green-400"
          >
            Back to chats
          </Link>
        </div>

        <section className={`${cardClass} mb-6`}>
          <SectionTitle>Profile</SectionTitle>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="relative">
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
                className="rounded-full transition hover:opacity-80 disabled:opacity-50"
                title={avatarUploading ? 'Uploading…' : 'Change your picture'}
                aria-label="Change your picture"
              >
                <Avatar url={user.avatarUrl} name={user.username} size={72} />
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold">{user.username}</p>
              <p className="truncate text-sm text-wizard-muted">{user.email ?? 'No email on file'}</p>
              <p className="mt-1 text-xs text-wizard-muted">
                Member since {new Date(user.createdAt).toLocaleDateString()} ·{' '}
                <span className={user.role === 'ADMIN' ? 'text-amber-400' : 'text-wizard-green-500'}>{user.role}</span>
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs transition hover:border-wizard-green-500/50 hover:text-wizard-green-400 disabled:opacity-50"
              >
                {avatarUploading ? 'Uploading…' : 'Change'}
              </button>
              {user.avatarUrl && (
                <button
                  type="button"
                  onClick={() => void handleRemoveAvatar()}
                  disabled={avatarUploading}
                  className="rounded-xl border border-white/10 px-3 py-2 text-xs transition hover:border-red-400/50 hover:text-red-400 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          {avatarError && <p className="mt-3 text-xs text-red-400">{avatarError}</p>}
        </section>

        <section className={`${cardClass} mb-6`}>
          <SectionTitle>Notifications</SectionTitle>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Web Push notifications</p>
              <p className="mt-0.5 text-xs text-wizard-muted">
                {pushState === 'checking'
                  ? 'Checking…'
                  : pushState === 'on'
                    ? 'New messages notify you even when the app isn’t open.'
                    : pushState === 'blocked'
                      ? 'Blocked in this browser. Allow notifications in your site settings, then re-enable here.'
                      : pushState === 'unsupported'
                        ? 'This browser does not support Web Push.'
                        : 'You won’t get message notifications on this device.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pushOn}
              aria-label="Toggle notifications"
              disabled={pushDisabled}
              onClick={() => void handleTogglePush()}
              className={`relative h-7 w-12 shrink-0 rounded-full transition ${
                pushOn ? 'bg-wizard-green-600' : 'bg-white/10'
              } disabled:opacity-40`}
            >
              <span
                className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
                  pushOn ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
          {pushError && <p className="mt-3 text-xs text-red-400">{pushError}</p>}
        </section>

        <section className={`${cardClass} mb-6`}>
          <SectionTitle>Security</SectionTitle>
          <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
            <div>
              <label htmlFor="curPw" className="mb-1.5 block text-sm font-medium text-wizard-muted">
                Current password
              </label>
              <input
                id="curPw"
                type="password"
                autoComplete="current-password"
                required
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="newPw" className="mb-1.5 block text-sm font-medium text-wizard-muted">
                New password
              </label>
              <input
                id="newPw"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="confirmPw" className="mb-1.5 block text-sm font-medium text-wizard-muted">
                Confirm new password
              </label>
              <input
                id="confirmPw"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                className={inputClass}
              />
            </div>
            {pwError && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400" role="alert">
                {pwError}
              </p>
            )}
            {pwNotice && (
              <p className="rounded-lg border border-wizard-green-500/20 bg-wizard-green-500/10 px-3 py-2 text-sm text-wizard-green-300" role="status">
                {pwNotice}
              </p>
            )}
            <button
              type="submit"
              disabled={pwSubmitting}
              className="w-full rounded-xl bg-gradient-to-b from-wizard-green-600 to-wizard-green-700 px-4 py-2.5 font-semibold text-white shadow-lg shadow-wizard-green-600/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
            >
              {pwSubmitting ? 'Updating…' : 'Change password'}
            </button>
          </form>
        </section>

        <section className={cardClass}>
          <SectionTitle>Account</SectionTitle>
          <div className="mt-4 flex flex-wrap gap-2">
            {user.role === 'ADMIN' && (
              <Link
                to="/admin"
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-300 transition hover:bg-amber-500/20"
              >
                Admin panel
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                void logout().then(() => navigate('/home', { replace: true }));
              }}
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/20"
            >
              Sign out
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function NavigateToHome() {
  return <Navigate to="/home" replace />;
}