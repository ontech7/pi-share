import clsx from 'clsx';

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'danger' }) {
  const ratio = Math.max(0, Math.min(1, value));
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <div
        className={clsx(
          'h-full origin-left rounded-full transition-transform duration-200 ease-out',
          tone === 'accent' && 'bg-accent',
          tone === 'ok' && 'bg-ok',
          tone === 'danger' && 'bg-danger',
        )}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}
