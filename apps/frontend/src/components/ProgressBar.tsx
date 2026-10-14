interface Props {
  /** 0-100 */
  value: number;
  label: string;
  tone?: 'primary' | 'muted';
}

export function ProgressBar({ value, label, tone = 'primary' }: Props) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-2 w-full overflow-hidden rounded-full bg-ink-800"
    >
      {/* A CSS transition, not Framer Motion, because the public watch page uses this too and
          shouldn't pull in the animation library. */}
      <div
        className={`h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none ${tone === 'primary' ? 'bg-primary' : 'bg-ink-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
