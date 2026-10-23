import clsx from 'clsx';
import {
  ArrowDownToLine,
  BadgeCheck,
  Ban,
  Bot,
  CircleX,
  Eye,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  OctagonX,
  Send,
  ShieldX,
  Unplug,
} from 'lucide-react';
import type { EventType, EventView, LinkItemView } from '../../../shared/api.ts';
import { countryFlag, formatBytes, formatDateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { parseAgent, previewApp } from '../../lib/ua.ts';

const ICONS: Record<EventType, { icon: LucideIcon; tone: string }> = {
  preview: { icon: Bot, tone: 'text-muted' },
  open: { icon: Eye, tone: 'text-fg' },
  password_failed: { icon: ShieldX, tone: 'text-danger' },
  unlocked: { icon: KeyRound, tone: 'text-ok' },
  locked: { icon: LockKeyhole, tone: 'text-danger' },
  download_started: { icon: ArrowDownToLine, tone: 'text-fg' },
  download_finished: { icon: Send, tone: 'text-ok' },
  download_aborted: { icon: Unplug, tone: 'text-warn' },
  download_verified: { icon: BadgeCheck, tone: 'text-ok' },
  download_failed: { icon: OctagonX, tone: 'text-danger' },
  refused: { icon: Ban, tone: 'text-warn' },
};

export function ActivityList({ events, items }: { events: EventView[]; items: LinkItemView[] }) {
  const { t, lang } = useI18n();

  if (events.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
        {t('detail.noActivity')}
      </p>
    );
  }

  return (
    <ol className="relative flex flex-col">
      {events.map((event) => {
        const { icon: Icon, tone } = ICONS[event.type] ?? { icon: CircleX, tone: 'text-muted' };
        const app = event.type === 'preview' ? previewApp(event.userAgent) : null;
        const agent = app ? null : parseAgent(event.userAgent);
        const isDownload = event.type.startsWith('download_');
        const fileName =
          event.path ??
          (event.file === null
            ? isDownload
              ? t('detail.bundle')
              : null
            : items.find((item) => item.position === event.file)?.name);
        const language = event.language?.split(',')[0];
        return (
          <li key={event.id} className="group relative flex gap-3 pb-5 last:pb-0">
            <span className="absolute top-9 bottom-0 left-[17px] w-px bg-line group-last:hidden" aria-hidden="true" />
            <span
              className={clsx(
                'relative grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface',
                tone,
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium">
                  {app ? t('notify.preview', { app }) : t(`event.${event.type}`)}
                  {fileName && <span className="font-normal text-muted"> · {fileName}</span>}
                </p>
                <time className="text-xs text-muted tabular" dateTime={new Date(event.at).toISOString()}>
                  {formatDateTime(event.at, lang)}
                </time>
              </div>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                {event.ip && (
                  <span className="font-mono">
                    {countryFlag(event.country)} {event.ip}
                  </span>
                )}
                {event.provider && (
                  <span title={`AS${event.provider.asn}`} className="flex items-center gap-1.5">
                    {event.provider.name}
                    {event.provider.hosting && (
                      <span className="rounded-full bg-warn/12 px-1.5 text-[11px] font-medium text-warn">
                        {t('provider.hosting')}
                      </span>
                    )}
                  </span>
                )}
                {agent && <span>{[agent.browser, agent.os].filter(Boolean).join(' · ')}</span>}
                {language && <span>{language}</span>}
                {event.bytes !== null && event.type !== 'download_started' && (
                  <span className="tabular">{formatBytes(event.bytes, lang)}</span>
                )}
                {event.detail && <span className="font-mono">{event.detail}</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
