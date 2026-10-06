import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSubmitting(true);
    try {
      await register(username.trim(), email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] focus:shadow-[0_0_0_4px_rgba(0,168,132,0.12)]';

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 text-2xl font-extrabold text-white shadow-lg shadow-wizard-green-500/25 ring-1 ring-white/10">
            W
          </div>
          <h1 className="mt-5 text-2xl font-bold tracking-tight">
            Create your <span className="wizard-grad-text">account</span>
          </h1>
          <p className="mt-1 text-sm text-wizard-muted">Join WizardChat securely</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="wizard-surface space-y-4 rounded-2xl border border-white/10 p-6 shadow-2xl shadow-black/40"
        >
          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[a-zA-Z0-9_]+"
              title="Letters, numbers, and underscores only"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Email <span className="text-wizard-green-500">(optional)</span>
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-wizard-muted">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
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
            {submitting ? 'Creating account…' : 'Create account'}
          </button>

          <p className="text-center text-sm text-wizard-muted">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-wizard-green-500 transition hover:text-wizard-green-100">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
