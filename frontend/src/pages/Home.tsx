import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getApiUrl } from '../lib/chatApi';
import { useAuth } from '../lib/auth';

type Status = 'checking' | 'online' | 'degraded' | 'offline';

function statusBadge(status: Status) {
  switch (status) {
    case 'online':
      return <span className="rounded-full bg-wizard-green-500/20 px-3 py-1 text-sm text-wizard-green-500">API online</span>;
    case 'degraded':
      return <span className="rounded-full bg-amber-500/20 px-3 py-1 text-sm text-amber-400">API up · DB down</span>;
    case 'offline':
      return <span className="rounded-full bg-red-500/20 px-3 py-1 text-sm text-red-400">API offline</span>;
    default:
      return <span className="rounded-full bg-white/10 px-3 py-1 text-sm text-wizard-muted">Checking…</span>;
  }
}

function InfrastructureCard() {
  const [status, setStatus] = useState<Status>('checking');
  const [detail, setDetail] = useState<string>('—');

  const check = useCallback(async () => {
    setStatus('checking');
    try {
      const healthRes = await fetch(`${getApiUrl()}/health`);
      if (!healthRes.ok) {
        setStatus('offline');
        setDetail(`HTTP ${healthRes.status}`);
        return;
      }
      const readyRes = await fetch(`${getApiUrl()}/ready`);
      if (readyRes.ok) {
        setStatus('online');
        setDetail('database up');
      } else {
        setStatus('degraded');
        setDetail('database down');
      }
    } catch {
      setStatus('offline');
      setDetail('cannot reach API');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <section className="rounded-2xl border border-white/10 bg-wizard-panel p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Infrastructure</h2>
        {statusBadge(status)}
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-wizard-bubble-in p-3">
          <dt className="text-xs text-wizard-muted">API endpoint</dt>
          <dd className="mt-0.5 break-all font-mono text-sm">{getApiUrl()}</dd>
        </div>
        <div className="rounded-xl bg-wizard-bubble-in p-3">
          <dt className="text-xs text-wizard-muted">Database</dt>
          <dd className="mt-0.5 font-mono text-sm">{detail}</dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={() => void check()}
        className="mt-4 rounded-lg border border-white/10 px-4 py-1.5 text-sm text-wizard-muted transition hover:border-wizard-green-500 hover:text-wizard-text"
      >
        Re-check
      </button>
    </section>
  );
}

function ChangePasswordForm() {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (newPassword !== confirm) {
      setMessage({ kind: 'err', text: 'Passwords do not match' });
      return;
    }
    if (newPassword.length < 8) {
      setMessage({ kind: 'err', text: 'New password must be at least 8 characters' });
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setMessage({ kind: 'ok', text: 'Password updated. Other sessions were signed out.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Change failed' });
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500';

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="current-password" className="mb-1.5 block text-sm text-wizard-muted">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="new-password" className="mb-1.5 block text-sm text-wizard-muted">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="mb-1.5 block text-sm text-wizard-muted">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </div>

      {message && (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${
            message.kind === 'ok' ? 'bg-wizard-green-500/10 text-wizard-green-500' : 'bg-red-500/10 text-red-400'
          }`}
          role="alert"
        >
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-xl bg-wizard-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-50"
      >
        {submitting ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}

export default function Home() {
  const { user, loading, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-wizard-green-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-wizard-green-600 text-2xl font-bold text-white">
            W
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">WizardChat</h1>
            <p className="text-sm text-wizard-muted">Secure messaging · end-to-end encrypted</p>
          </div>
        </div>
        {user && (
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            className="rounded-xl border border-white/10 px-4 py-2 text-sm text-wizard-muted transition hover:border-red-400/50 hover:text-red-400 disabled:opacity-50"
          >
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        )}
      </header>

      <main className="mt-10 flex flex-1 flex-col gap-6">
        {user ? (
          <section className="rounded-2xl border border-white/10 bg-wizard-panel p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-wizard-green-600 text-xl font-bold text-white uppercase">
                {user.username.slice(0, 2)}
              </div>
              <div>
                <h2 className="text-xl font-semibold">{user.username}</h2>
                {user.email && <p className="text-sm text-wizard-muted">{user.email}</p>}
              </div>
              <span
                className={`ml-auto rounded-full px-3 py-1 text-xs font-semibold ${
                  user.role === 'ADMIN' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10 text-wizard-muted'
                }`}
              >
                {user.role}
              </span>
            </div>
            <p className="mt-4 text-sm text-wizard-muted">
              You are signed in.{' '}
              <Link to="/" className="text-wizard-green-500 hover:underline">
                Open your chats →
              </Link>
            </p>
          </section>
        ) : (
          <section className="rounded-2xl border border-white/10 bg-wizard-panel p-8 text-center">
            <h2 className="text-xl font-semibold">Welcome to WizardChat</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-wizard-muted">
              Sign in or create an account to start chatting. Every request is authenticated
              server-side — editing the page source won't get you past the API.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Link
                to="/login"
                className="rounded-xl bg-wizard-green-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-wizard-green-700"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-semibold text-wizard-text transition hover:border-wizard-green-500"
              >
                Create account
              </Link>
            </div>
          </section>
        )}

        {user && (
          <section className="rounded-2xl border border-white/10 bg-wizard-panel p-6">
            <h2 className="text-lg font-semibold">Change password</h2>
            <p className="mb-4 mt-1 text-sm text-wizard-muted">
              Changing your password revokes all other sessions on all devices.
            </p>
            <ChangePasswordForm />
          </section>
        )}

        <InfrastructureCard />
      </main>

      <footer className="mt-12 text-center text-xs text-wizard-muted">
        Phase 3 · real-time DMs · frontend on GitHub Pages · API on Render · database on Neon
      </footer>
    </div>
  );
}
