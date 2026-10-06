import { useAuth } from '../lib/auth';

export default function SessionNotice() {
  const { accountNotice, clearAccountNotice } = useAuth();
  if (!accountNotice) return null;
  return (
    <div className="mx-auto mb-4 flex w-full max-w-md items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-amber-200 shadow-lg shadow-black/20 backdrop-blur-xl">
      <p className="flex-1 text-sm">{accountNotice}</p>
      <button
        type="button"
        onClick={clearAccountNotice}
        className="shrink-0 rounded px-1 text-sm text-amber-300/70 transition hover:text-amber-200"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}