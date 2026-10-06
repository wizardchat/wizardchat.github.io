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
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-wizard-green-600 text-2xl font-bold text-white">
            W
          </div>
          <h1 className="mt-4 text-2xl font-bold">Sign in to WizardChat</h1>
          <p className="mt-1 text-sm text-wizard-muted">End-to-end encrypted messaging</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-white/10 bg-wizard-panel p-6">
          <div>
            <label htmlFor="identifier" className="mb-1.5 block text-sm text-wizard-muted">
              Username or email
            </label>
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm text-wizard-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-wizard-bubble-in px-4 py-2.5 text-wizard-text outline-none transition focus:border-wizard-green-500"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-wizard-green-600 px-4 py-2.5 font-semibold text-white transition hover:bg-wizard-green-700 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-center text-sm text-wizard-muted">
            No account?{' '}
            <Link to="/register" className="text-wizard-green-500 hover:underline">
              Create one
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
