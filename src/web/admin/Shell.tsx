import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useI18n } from '../lib/i18n-context.tsx';
import { Logo } from '../ui/Logo.tsx';
import { api, keys } from './api.ts';
import { ServiceToggle } from './ServiceToggle.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [location] = useLocation();
  const inSettings = location.startsWith('/settings');
  const updates = useQuery({ queryKey: keys.updates, queryFn: api.updates, refetchInterval: 30 * 60 * 1000 });
  const available = updates.data?.available ? updates.data.latest?.version : null;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/" className="press flex items-center gap-2.5 rounded-xl">
              <Logo className="size-8" />
              <span className="font-mono text-[15px] font-medium tracking-tight">pi-share</span>
            </Link>
            {available ? (
              <Link
                href="/settings/updates"
                title={t('updates.available', { version: available })}
                className="press flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-xs font-medium text-accent-strong hover:bg-accent/25"
              >
                <ArrowUpCircle className="size-3.5" />
                <span className="max-sm:sr-only">{t('updates.availableShort', { version: available })}</span>
              </Link>
            ) : (
              <span className="hidden font-mono text-xs text-muted sm:inline">v{__APP_VERSION__}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ServiceToggle />
            <Link
              href="/settings"
              aria-label={t('settings.title')}
              title={t('settings.title')}
              aria-current={inSettings ? 'page' : undefined}
              className={clsx(
                'press grid size-10 place-items-center rounded-xl transition-colors',
                inSettings ? 'bg-surface-2 text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              <Settings2 className="size-5" />
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">{children}</main>
    </div>
  );
}
