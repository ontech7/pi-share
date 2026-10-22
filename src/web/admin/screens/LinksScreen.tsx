import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ChevronRight, Eye, FileStack, Lock, Plus, Users } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import type { LinkSummary } from '../../../shared/api.ts';
import { formatBytes, formatRelative } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { api, keys } from '../api.ts';
import { CreateLinkDialog } from '../create/CreateLinkDialog.tsx';
import { LinkStateBadge } from '../status.tsx';

export function LinksScreen() {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const links = useQuery({ queryKey: keys.links, queryFn: api.links, refetchInterval: 10_000 });

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('links.title')}</h1>
          {links.data && links.data.length > 0 && (
            <p className="mt-1 text-sm text-muted tabular">
              {links.data.filter((link) => link.state === 'active').length} / {links.data.length}
            </p>
          )}
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          {t('links.new')}
        </Button>
      </div>

      {links.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 rounded-2xl border border-line bg-surface" />
          ))}
        </div>
      ) : links.isError ? (
        <Card className="p-6 text-sm text-danger">{t('common.network')}</Card>
      ) : links.data.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <ul className="flex flex-col gap-3">
          {links.data.map((link, index) => (
            <li key={link.id} className="animate-enter" style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
              <LinkCard link={link} />
            </li>
          ))}
        </ul>
      )}

      <CreateLinkDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function LinkCard({ link }: { link: LinkSummary }) {
  const { t, lang } = useI18n();
  const size = link.items.reduce((total, item) => total + item.size, 0);
  const names = link.items.map((item) => (item.kind === 'folder' ? `${item.name}/` : item.name));

  return (
    <Link
      href={`/links/${link.id}`}
      className="group press block rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-accent-strong/40 sm:p-5"
    >
      <div className="flex items-start gap-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent-strong">
          <FileStack className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="truncate font-semibold tracking-tight">{link.label || t('links.untitled')}</h2>
            <LinkStateBadge state={link.state} />
            {link.hasPassword && <Lock className="size-3.5 text-muted" aria-label={t('detail.password')} />}
          </div>
          <p className="mt-1 truncate text-sm text-muted">
            {names.slice(0, 2).join(', ')}
            {names.length > 2 && ` +${names.length - 2}`}
            <span className="mx-1.5">·</span>
            <span className="tabular">{formatBytes(size, lang)}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted tabular">
            <Stat icon={<Eye className="size-4" />} value={link.counts.opens} label={t('counts.opens')} />
            <Stat
              icon={<ArrowDownToLine className="size-4" />}
              value={link.counts.downloads}
              label={t('counts.downloads')}
            />
            <Stat icon={<Users className="size-4" />} value={link.counts.visitors} label={t('counts.visitors')} />
            <span className="text-xs">
              {link.lastActivityAt
                ? t('links.lastActivity', { when: formatRelative(link.lastActivityAt, lang) })
                : t('links.noActivity')}
            </span>
          </div>
        </div>
        <ChevronRight className="mt-3 size-5 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function Stat({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5" title={label}>
      {icon}
      <span className="font-medium text-fg">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <Card className="relative overflow-hidden px-6 py-16 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 size-96 -translate-x-1/2 bg-[radial-gradient(closest-side,var(--accent),transparent)] opacity-15"
      />
      <div className="relative mx-auto flex max-w-sm flex-col items-center gap-4">
        <div className="grid size-14 animate-pop place-items-center rounded-2xl bg-accent text-on-accent">
          <FileStack className="size-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{t('links.emptyTitle')}</h2>
        <p className="text-sm leading-relaxed text-muted">{t('links.emptyBody')}</p>
        <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={onCreate}>
          {t('links.new')}
        </Button>
      </div>
    </Card>
  );
}
