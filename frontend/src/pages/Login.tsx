import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(identifier.trim(), password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 text-2xl font-extrabold text-white shadow-lg shadow-wizard-green-500/25 ring-1 ring-white/10">
            W
          </div>
          <h1 className="mt-5 text-2xl font-bold tracking-tight">
            Sign in to <span className="wizard-grad-text">WizardChat</span>
          </h1>
          <p className="mt-1 text-sm text-wizard-muted">End-to-end encrypted messaging</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="wizard-surface space-y-4 rounded-2xl border border-white/10 p-6 shadow-2xl shadow-black/40"
        >
          <div>
            <label htmlFor="identifier" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Username or email
            </label>
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)]"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)]"
            />
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-gradient-to-b from-wizard-green-600 to-wizard-green-700 px-4 py-2.5 font-semibold text-white shadow-lg shadow-wizard-green-600/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-center text-sm text-wizard-muted">
            No account?{' '}
            <Link to="/register" className="font-medium text-wizard-green-500 transition hover:text-wizard-green-100">
              Create one
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
