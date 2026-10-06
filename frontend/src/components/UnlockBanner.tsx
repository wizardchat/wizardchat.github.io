import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

interface Props {
  onUnlocked: () => void;
}

export default function UnlockBanner({ onUnlocked }: Props) {
  const { unlockE2EE } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const ok = await unlockE2EE(password);
    setBusy(false);
    if (ok) {
      setPassword('');
      onUnlocked();
    } else {
      setError('Could not unlock — wrong password or key unavailable');
    }
  }

  return (
    <div className="border-b border-amber-400/25 bg-amber-400/10 px-4 py-3 backdrop-blur-xl">
      <p className="text-sm text-amber-200">
        🔒 End-to-end encrypted messages are locked on this device.
      </p>
      <form onSubmit={handleSubmit} className="mt-2 flex gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password to unlock"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-wizard-text outline-none transition placeholder:text-amber-200/40 focus:border-amber-400/60 focus:shadow-[0_0_0_4px_rgba(251,191,36,0.12)]"
          autoFocus
        />
        <button
          type="submit"
          disabled={!password || busy}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black shadow-lg shadow-amber-500/20 transition hover:bg-amber-400 hover:brightness-105 disabled:opacity-40"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}
