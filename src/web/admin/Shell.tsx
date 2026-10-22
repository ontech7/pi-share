import { Settings2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { useI18n } from '../lib/i18n-context.tsx';
import { IconButton } from '../ui/Button.tsx';
import { Logo } from '../ui/Logo.tsx';
import { ServiceToggle } from './ServiceToggle.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" className="press flex items-center gap-2.5 rounded-xl">
            <Logo className="size-8" />
            <span className="font-mono text-[15px] font-medium tracking-tight">pi-share</span>
          </Link>
          <div className="flex items-center gap-2">
            <ServiceToggle />
            <IconButton
              label={t('settings.title')}
              icon={<Settings2 className="size-5" />}
              onClick={() => setSettingsOpen(true)}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">{children}</main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
