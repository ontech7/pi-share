import clsx from 'clsx';
import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/12 text-warn',
  danger: 'bg-danger/12 text-danger',
  muted: 'bg-surface-2 text-muted',
  accent: 'bg-accent/20 text-accent-strong',
};

export function Badge({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', TONES[tone])}
    >
      <span className={clsx('size-1.5 rounded-full bg-current', pulse && 'animate-pulse-dot')} />
      {children}
    </span>
  );
}
