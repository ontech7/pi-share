import clsx from 'clsx';
import {
  ArrowLeft,
  ArrowUpCircle,
  BellRing,
  ChevronRight,
  Globe,
  KeyRound,
  Link2,
  type LucideIcon,
  Palette,
  Radio,
  UserRound,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Link } from 'wouter';
import type { MessageKey } from '../../lib/i18n.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Card } from '../../ui/Card.tsx';
import { AccountSection } from '../settings/AccountSection.tsx';
import { ActivitySection } from '../settings/ActivitySection.tsx';
import { AppearanceSection } from '../settings/AppearanceSection.tsx';
import { IntegrationsSection } from '../settings/IntegrationsSection.tsx';
import { NewLinksSection } from '../settings/NewLinksSection.tsx';
import { NotificationsSection } from '../settings/NotificationsSection.tsx';
import { ServiceSection } from '../settings/ServiceSection.tsx';
import { UpdatesSection } from '../settings/UpdatesSection.tsx';

type Section = {
  id: string;
  icon: LucideIcon;
  title: MessageKey;
  hint: MessageKey;
  intro?: MessageKey;
  body: ComponentType;
};

const SECTIONS: Section[] = [
  { id: 'service', icon: Radio, title: 'settings.service', hint: 'settings.serviceHint', body: ServiceSection },
  {
    id: 'links',
    icon: Link2,
    title: 'settings.newLinks',
    hint: 'settings.newLinksShort',
    intro: 'settings.newLinksHint',
    body: NewLinksSection,
  },
  {
    id: 'activity',
    icon: Globe,
    title: 'settings.activity',
    hint: 'settings.activityHint',
    intro: 'settings.activityIntro',
    body: ActivitySection,
  },
  {
    id: 'notifications',
    icon: BellRing,
    title: 'settings.notifications',
    hint: 'settings.notificationsHint',
    intro: 'settings.notificationsIntro',
    body: NotificationsSection,
  },
  {
    id: 'integrations',
    icon: KeyRound,
    title: 'settings.integrations',
    hint: 'settings.integrationsHint',
    intro: 'settings.integrationsIntro',
    body: IntegrationsSection,
  },
  {
    id: 'updates',
    icon: ArrowUpCircle,
    title: 'updates.title',
    hint: 'updates.hint',
    intro: 'updates.intro',
    body: UpdatesSection,
  },
  {
    id: 'appearance',
    icon: Palette,
    title: 'settings.appearance',
    hint: 'settings.appearanceHint',
    intro: 'settings.appearanceIntro',
    body: AppearanceSection,
  },
  { id: 'account', icon: UserRound, title: 'settings.account', hint: 'settings.accountHint', body: AccountSection },
];

/**
 * Wide screens show the sections in a sidebar next to the open one. On a phone `/settings` is the list of
 * sections and each section opens on its own, with a way back, like the system settings.
 */
export function SettingsScreen({ section }: { section?: string }) {
  const { t } = useI18n();
  const open = SECTIONS.find((candidate) => candidate.id === section);
  const shown = open ?? (SECTIONS[0] as Section);
  const Body = shown.body;

  return (
    <div className="flex animate-enter flex-col gap-6">
      <h1 className={clsx('text-2xl font-semibold tracking-tight sm:text-3xl', open && 'max-md:hidden')}>
        {t('settings.title')}
      </h1>

      <div className="grid gap-8 md:grid-cols-[220px_1fr]">
        <nav aria-label={t('settings.title')} className={clsx(open && 'max-md:hidden')}>
          <Card className="divide-y divide-line md:hidden">
            {SECTIONS.map(({ id, icon: Icon, title, hint }) => (
              <Link key={id} href={`/settings/${id}`} className="flex items-center gap-3 px-4 py-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent-strong">
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">{t(title)}</span>
                  <span className="block truncate text-sm text-muted">{t(hint)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </Link>
            ))}
          </Card>
          <p className="mt-4 text-center font-mono text-xs text-muted md:hidden">pi-share v{__APP_VERSION__}</p>
          <ul className="sticky top-24 flex flex-col gap-1 max-md:hidden">
            {SECTIONS.map(({ id, icon: Icon, title }) => {
              const active = id === shown.id;
              return (
                <li key={id}>
                  <Link
                    href={`/settings/${id}`}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'press flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                      active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                    )}
                  >
                    <Icon className={clsx('size-4', active && 'text-accent-strong')} />
                    {t(title)}
                  </Link>
                </li>
              );
            })}
            <li className="mt-4 px-3 font-mono text-xs text-muted">pi-share v{__APP_VERSION__}</li>
          </ul>
        </nav>

        <section className={clsx('flex min-w-0 flex-col gap-4', !open && 'max-md:hidden')}>
          <Link
            href="/settings"
            className="press -ml-2 flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg md:hidden"
          >
            <ArrowLeft className="size-4" />
            {t('settings.title')}
          </Link>
          <div key={shown.id} className="animate-enter">
            <h2 className="text-xl font-semibold tracking-tight">{t(shown.title)}</h2>
            <p className="mt-1 text-sm text-muted">{t(shown.intro ?? shown.hint)}</p>
          </div>
          <Body key={`body-${shown.id}`} />
        </section>
      </div>
    </div>
  );
}
