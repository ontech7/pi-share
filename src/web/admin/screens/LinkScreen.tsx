import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CirclePause,
  FileText,
  Folder,
  Lock,
  LockOpen,
  MessageSquareWarning,
  Network,
  Pencil,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { ChangeView, LinkDetail, UpdateLinkBody } from '../../../shared/api.ts';
import { formatBytes, formatDate, formatDateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { previewApp } from '../../lib/ua.ts';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { ApiError, api, keys } from '../api.ts';
import { ActivityList } from '../detail/ActivityList.tsx';
import { EditLinkDialog } from '../detail/EditLinkDialog.tsx';
import { FileStateBadge, LinkStateBadge } from '../status.tsx';

export function LinkScreen({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState(false);
  const link = useQuery({ queryKey: keys.link(id), queryFn: () => api.link(id), refetchInterval: 5_000 });

  const update = useMutation({
    mutationFn: (patch: UpdateLinkBody) => api.updateLink(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.link(id), updated);
      queryClient.invalidateQueries({ queryKey: keys.links });
      queryClient.invalidateQueries({ queryKey: keys.service });
    },
    onError: () => notify(t('common.error'), 'error'),
  });
  const accept = useMutation({
    mutationFn: ({ version, confirmSensitive }: { version: string; confirmSensitive?: boolean }) =>
      api.updateLink(id, { acceptChanges: version, confirmSensitive }),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.link(id), updated);
      queryClient.invalidateQueries({ queryKey: keys.links });
      queryClient.invalidateQueries({ queryKey: keys.service });
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.code === 'sensitive') {
        const files = (error.data.files as string[]).join('\n');
        if (window.confirm(t('detail.acceptSensitive', { files }))) {
          accept.mutate({ ...variables, confirmSensitive: true });
        }
        return;
      }
      if (error instanceof ApiError && error.code === 'changes_moved') notify(t('detail.changesMoved'), 'error');
      else notify(t('common.error'), 'error');
      queryClient.invalidateQueries({ queryKey: keys.link(id) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLink(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: keys.link(id) });
      queryClient.invalidateQueries({ queryKey: keys.links });
      queryClient.invalidateQueries({ queryKey: keys.service });
      navigate('/');
    },
  });

  if (link.isPending) {
    return (
      <div className="grid h-64 place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (link.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <BackLink />
        <Card className="w-full p-6 text-sm text-danger">{t('common.error')}</Card>
      </div>
    );
  }

  const data: LinkDetail = link.data;
  const changed = data.changes.length > 0;
  const downloads = String(data.counts.downloads);

  return (
    <div className="flex animate-enter flex-col gap-8">
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
                {data.label || t('links.untitled')}
              </h1>
              <LinkStateBadge state={data.state} />
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>
                {t('detail.created')} {formatDate(data.createdAt, lang)}
              </span>
              <span>
                {t('detail.expires')} {data.expiresAt ? formatDate(data.expiresAt, lang) : t('common.never')}
              </span>
              {data.maxDownloads && (
                <span className="flex items-center gap-1 tabular">
                  <Users className="size-3.5" />
                  {t('detail.limitUsed', { n: data.counts.recipients, max: data.maxDownloads })}
                </span>
              )}
              <span className="flex items-center gap-1">
                {data.onChange === 'pause' ? <CirclePause className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                {data.onChange === 'pause' ? t('create.onChangePause') : t('create.onChangeFollow')}
              </span>
              <span className="flex items-center gap-1">
                {data.hasPassword ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {t('detail.password')}: {data.hasPassword ? t('detail.passwordSet') : t('detail.passwordNone')}
              </span>
              {data.allowedNetworks.length > 0 && (
                <span className="flex items-center gap-1">
                  <Network className="size-3.5" />
                  <span className="font-mono">{data.allowedNetworks.join(', ')}</span>
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-full border border-line bg-surface py-1 pr-1 pl-4">
            <span className="text-sm font-medium">
              {data.state === 'disabled' ? t('state.disabled') : t('state.active')}
            </span>
            <Switch
              checked={data.state !== 'disabled' && data.state !== 'locked'}
              onChange={(active) => update.mutate({ active })}
              label={data.state === 'disabled' ? t('actions.enable') : t('actions.disable')}
            />
          </div>
        </div>
      </div>

      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 truncate font-mono text-sm text-muted select-all" title={data.url}>
          {data.url}
        </p>
        <div className="flex gap-2">
          <CopyButton
            value={data.url}
            label={t('actions.copyLink')}
            copiedLabel={t('common.copied')}
            variant="primary"
          />
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
            {t('actions.edit')}
          </Button>
        </div>
      </Card>

      <PastedInChats link={data} />

      {data.state === 'locked' && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-danger/40 p-4">
          <p className="text-sm">{t('event.locked')}</p>
          <Button variant="danger" onClick={() => update.mutate({ active: true })} loading={update.isPending}>
            {t('actions.unlock')}
          </Button>
        </Card>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label={t('counts.opens')} value={data.counts.opens} />
        <Tile label={t('counts.downloads')} value={downloads} />
        <Tile label={t('counts.verified')} value={data.counts.verified} accent />
        <Tile label={t('counts.visitors')} value={data.counts.visitors} />
        <Tile
          label={t('counts.failedPasswords')}
          value={data.counts.failedPasswords}
          danger={data.counts.failedPasswords > 0}
        />
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{t('detail.files')}</h2>
        {changed && (
          <Card className={`flex flex-col gap-4 p-4 ${data.onChange === 'pause' ? 'border-warn/40' : 'border-line'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-sm">
                {data.onChange === 'pause' ? t('actions.acceptChangesHint') : t('actions.acceptChangesFollow')}
              </p>
              <Button
                icon={<RefreshCw className="size-4" />}
                onClick={() => accept.mutate({ version: data.version })}
                loading={accept.isPending}
              >
                {t('actions.acceptChanges')}
              </Button>
            </div>
            <ChangeList changes={data.changes} />
          </Card>
        )}
        <Card className="divide-y divide-line">
          {data.items.map((item) => (
            <div key={item.position} className="flex items-center gap-3 px-4 py-3">
              {item.kind === 'folder' ? (
                <Folder className="size-5 shrink-0 text-accent-strong" />
              ) : (
                <FileText className="size-5 shrink-0 text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{item.name}</p>
                <p className="truncate font-mono text-xs text-muted">{item.path}</p>
              </div>
              <span className="hidden shrink-0 text-right text-sm text-muted tabular sm:block">
                {item.kind === 'folder' && `${t('share.files', { n: item.fileCount })} · `}
                {formatBytes(item.size, lang)}
              </span>
              {item.changes && item.state === 'changed' && <ChangeCounts {...item.changes} />}
              <FileStateBadge state={item.state} />
            </div>
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{t('detail.activity')}</h2>
        <ActivityList events={data.events} items={data.items} />
      </section>

      <div className="border-t border-line pt-6">
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" />}
          loading={remove.isPending}
          onClick={() => {
            if (window.confirm(t('actions.deleteConfirm'))) remove.mutate();
          }}
        >
          {t('actions.delete')}
        </Button>
      </div>

      {editing && <EditLinkDialog link={data} open={editing} onClose={() => setEditing(false)} />}
    </div>
  );
}

/**
 * A chat that shows a preview of the link holds the whole of it, key included, for as long as the message
 * stays: everyone who can read that chat can open the files, and so can the service unless it is end-to-end
 * encrypted.
 */
function PastedInChats({ link }: { link: LinkDetail }) {
  const { t, lang } = useI18n();
  const previews = link.events.filter((event) => event.type === 'preview');
  if (previews.length === 0) return null;
  const known = [...new Set(previews.map((event) => previewApp(event.userAgent)).filter((app) => app !== null))];
  const apps = known.length ? new Intl.ListFormat(lang, { type: 'conjunction' }).format(known) : t('notify.chatApp');
  const last = Math.max(...previews.map((event) => event.at));
  return (
    <Card className="flex gap-3 border-warn/40 p-4">
      <MessageSquareWarning className="mt-0.5 size-5 shrink-0 text-warn" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[15px] font-medium">
          {t('detail.pastedTitle', { apps, when: formatDateTime(last, lang, { seconds: false }) })}
        </p>
        <p className="text-sm text-muted">
          {t('detail.pastedBody')} {!link.hasPassword && t('detail.pastedNoPassword')}
        </p>
      </div>
    </Card>
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link
      href="/"
      className="press -ml-2 flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg"
    >
      <ArrowLeft className="size-4" />
      {t('links.title')}
    </Link>
  );
}

function Tile({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd
        className={`text-2xl font-semibold tracking-tight tabular ${accent ? 'text-accent-strong' : danger ? 'text-danger' : ''}`}
      >
        {value}
      </dd>
    </Card>
  );
}

const VISIBLE_CHANGES = 8;

function ChangeList({ changes }: { changes: ChangeView[] }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, VISIBLE_CHANGES);
  const tone = { added: 'text-ok', removed: 'text-danger', changed: 'text-warn' } as const;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{t('detail.changes')}</h3>
      <ul className="flex flex-col gap-1 font-mono text-xs">
        {shown.map((change) => (
          <li key={`${change.change}:${change.path}`} className="flex min-w-0 gap-2">
            <span className={`w-20 shrink-0 ${tone[change.change]}`}>{t(`change.${change.change}`)}</span>
            <span className="truncate text-muted" title={change.path}>
              {change.path}
            </span>
          </li>
        ))}
      </ul>
      {!all && changes.length > VISIBLE_CHANGES && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="press self-start rounded-md text-xs font-medium text-accent-strong hover:underline"
        >
          {t('detail.moreChanges', { n: changes.length - VISIBLE_CHANGES })}
        </button>
      )}
    </div>
  );
}

function ChangeCounts({ added, removed, changed }: { added: number; removed: number; changed: number }) {
  return (
    <span className="hidden shrink-0 gap-1.5 font-mono text-xs tabular sm:flex">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {removed > 0 && <span className="text-danger">−{removed}</span>}
      {changed > 0 && <span className="text-warn">~{changed}</span>}
    </span>
  );
}
