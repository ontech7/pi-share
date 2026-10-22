import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileText, Lock, LockOpen, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { LinkDetail, UpdateLinkBody } from '../../../shared/api.ts';
import { formatBytes, formatDate } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { api, keys } from '../api.ts';
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
  const changed = data.files.some((file) => file.state === 'changed');
  const downloads = data.maxDownloads ? `${data.counts.started} / ${data.maxDownloads}` : String(data.counts.downloads);

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
              <span className="flex items-center gap-1">
                {data.hasPassword ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {t('detail.password')}: {data.hasPassword ? t('detail.passwordSet') : t('detail.passwordNone')}
              </span>
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
          <Card className="flex flex-wrap items-center justify-between gap-3 border-warn/40 p-4">
            <p className="max-w-xl text-sm">{t('actions.acceptChangesHint')}</p>
            <Button
              icon={<RefreshCw className="size-4" />}
              onClick={() => update.mutate({ acceptChanges: true })}
              loading={update.isPending}
            >
              {t('actions.acceptChanges')}
            </Button>
          </Card>
        )}
        <Card className="divide-y divide-line">
          {data.files.map((file) => (
            <div key={file.position} className="flex items-center gap-3 px-4 py-3">
              <FileText className="size-5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{file.name}</p>
                <p className="truncate font-mono text-xs text-muted">{file.path}</p>
              </div>
              <span className="hidden text-sm text-muted tabular sm:block">{formatBytes(file.size, lang)}</span>
              <FileStateBadge state={file.state} />
            </div>
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{t('detail.activity')}</h2>
        <ActivityList events={data.events} files={data.files} />
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
