interface Props {
  url?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}

export default function Avatar({ url, name, size = 40, className = '' }: Props) {
  const initials = (name ?? '?').slice(0, 2).toUpperCase();
  if (url) {
    return (
      <img
        src={url}
        alt={initials}
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-full object-cover ring-1 ring-white/10 ${className}`}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.round(size * 0.35) }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 font-bold uppercase text-white shadow-[inset_0_-2px_8px_rgba(0,0,0,0.25)] ring-1 ring-white/10 ${className}`}
    >
      {initials}
    </div>
  );
}