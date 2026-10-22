import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n-context.tsx';
import { Card } from '../ui/Card.tsx';
import { Logo } from '../ui/Logo.tsx';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-64 left-1/2 size-[640px] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--accent),transparent)] opacity-20"
      />
      <div className="relative w-full max-w-sm animate-enter">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo className="size-12" />
          <div>
            <p className="font-mono text-sm tracking-tight text-muted">pi-share</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          </div>
        </div>
        <Card className="p-6">{children}</Card>
        <p className="mt-6 text-center text-sm text-muted">{t('app.tagline')}</p>
      </div>
    </main>
  );
}
