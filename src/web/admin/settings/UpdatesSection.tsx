import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, Check, CircleAlert, ExternalLink, RefreshCw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { finalUpdateStates, type UpdateInfo, type UpdateState } from '../../../shared/api.ts';
import { formatDate } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { ApiError, api, keys } from '../api.ts';
import { ReleaseNotes } from './ReleaseNotes.tsx';
import { SettingRow } from './Row.tsx';

const STEPS: UpdateState[] = ['queued', 'checking', 'downloading', 'backing_up', 'restarting', 'done'];
const SILENT_UPDATER = 60_000;
const IMAGE = 'ghcr.io/ontech7/pi-share';

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) > (y?.[i] ?? 0);
  return false;
};
const running = (info: UpdateInfo | undefined) => !!info?.status && !finalUpdateStates.includes(info.status.state);

export function UpdatesSection() {
  const { t, lang } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [requestedAt, setRequestedAt] = useState(0);

  // While an update runs, poll; while pi-share restarts the admin is briefly unreachable, so keep retrying.
  const updates = useQuery({
    queryKey: keys.updates,
    queryFn: api.updates,
    refetchInterval: (query) => (target || running(query.state.data) ? 2_000 : false),
    retry: target ? Number.POSITIVE_INFINITY : 3,
  });
  const set = (info: UpdateInfo) => queryClient.setQueryData(keys.updates, info);
  const check = useMutation({ mutationFn: api.checkUpdates, onSuccess: set });
  const autoCheck = useMutation({ mutationFn: api.setAutoCheck, onSuccess: set });
  const install = useMutation({
    mutationFn: api.installUpdate,
    onSuccess: (info, version) => {
      set(info);
      setTarget(version);
      setRequestedAt(Date.now());
      setConfirming(false);
    },
    onError: (error) => {
      setConfirming(false);
      const code = error instanceof ApiError ? error.code : '';
      const known = ['not_available', 'in_progress', 'not_installable'].includes(code);
      notify(known ? t(`updates.error.${code}` as 'updates.error.in_progress') : t('common.error'), 'error');
    },
  });

  const info = updates.data;
  useEffect(() => {
    if (!target || !info) return;
    if (info.current === target) {
      notify(t('updates.updated', { version: target }));
      const reload = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(reload);
    }
    const status = info.status;
    if (status?.version === target && (status.state === 'failed' || status.state === 'rolled_back')) setTarget(null);
    return undefined;
  }, [target, info, notify, t]);

  if (!info) {
    return (
      <Card className="grid h-40 place-items-center text-muted">
        <Spinner className="size-5" />
      </Card>
    );
  }

  const { latest } = info;
  // Until the updater picks the request up, the last status it wrote is about an older update.
  const waiting = !!target && info.status?.version !== target;
  const status = waiting && target ? { state: 'queued' as const, version: target, message: null, at: 0 } : info.status;
  const silent = waiting && Date.now() - requestedAt > SILENT_UPDATER;
  const showStatus = !!status && (newer(status.version, info.current) || running(info) || !!target);
  const restarting = !!target && updates.isError;

  return (
    <div className="flex flex-col gap-4">
      <Card className="divide-y divide-line">
        <SettingRow label={t('updates.current')}>
          <span className="font-mono text-sm">v{info.current}</span>
        </SettingRow>
        <SettingRow
          label={t('updates.latest')}
          hint={
            info.error ? (
              <span className="text-danger">{t('updates.unreachable')}</span>
            ) : latest ? (
              <>
                <span className="font-mono text-fg">v{latest.version}</span>
                {latest.publishedAt && ` · ${formatDate(Date.parse(latest.publishedAt), lang)}`}
                {!info.available && ` · ${t('updates.upToDate')}`}
              </>
            ) : (
              t('updates.never')
            )
          }
        >
          <Button
            size="sm"
            icon={<RefreshCw className="size-4" />}
            loading={check.isPending}
            onClick={() => check.mutate()}
          >
            {t('updates.checkNow')}
          </Button>
        </SettingRow>
        <SettingRow label={t('updates.autoCheck')} hint={t('updates.autoCheckHint')}>
          <Switch
            checked={info.autoCheck}
            onChange={(value) => autoCheck.mutate(value)}
            label={t('updates.autoCheck')}
          />
        </SettingRow>
      </Card>

      {(showStatus || restarting) && status && (
        <Card className="flex animate-enter flex-col gap-3 p-4 sm:p-5">
          <p className="text-[15px] font-medium">{t('updates.install', { version: status.version })}</p>
          {status.state === 'failed' || status.state === 'rolled_back' ? (
            <div className={clsx('flex gap-2 text-sm', status.state === 'failed' ? 'text-danger' : 'text-warn')}>
              {status.state === 'failed' ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              ) : (
                <Undo2 className="mt-0.5 size-4 shrink-0" />
              )}
              <div>
                <p className="font-medium">{t(`updates.state.${status.state}`)}</p>
                {status.message && <p className="mt-0.5 font-mono text-xs text-muted">{status.message}</p>}
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-2 text-sm">
              {STEPS.map((step, index) => {
                const reached = STEPS.indexOf(status.state);
                const done = index < reached || status.state === 'done';
                const current = index === reached && status.state !== 'done';
                return (
                  <li key={step} className={clsx('flex items-center gap-2', !done && !current && 'text-muted')}>
                    {done ? (
                      <Check className="size-4 text-ok" />
                    ) : current ? (
                      <Spinner className="size-4 text-accent-strong" />
                    ) : (
                      <span className="grid size-4 place-items-center">
                        <span className="size-1.5 rounded-full bg-line" />
                      </span>
                    )}
                    {t(`updates.state.${step}`)}
                  </li>
                );
              })}
            </ol>
          )}
          {restarting && <p className="text-sm text-muted">{t('updates.restarting')}</p>}
          {silent && <p className="text-sm text-warn">{t('updates.silent')}</p>}
        </Card>
      )}

      {info.available && latest && !running(info) && !target && (
        <Card className="flex animate-enter flex-col gap-4 border-accent-strong/40 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-accent-strong" />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">{t('updates.available', { version: latest.version })}</p>
              <a
                href={latest.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex items-center gap-1 text-sm text-accent-strong hover:underline"
              >
                {t('updates.onGitHub')}
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          </div>
          {latest.notes && (
            <div className="rounded-xl bg-surface-2/60 p-3">
              <ReleaseNotes markdown={latest.notes} />
            </div>
          )}
          {info.installable ? (
            <Button variant="primary" className="self-start" onClick={() => setConfirming(true)}>
              {t('updates.install', { version: latest.version })}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-muted">{t('updates.manual')}</p>
              <pre className="overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs">
                {`PI_SHARE_IMAGE=${IMAGE}:${latest.version}  # in .env\ndocker compose pull && docker compose up -d`}
              </pre>
            </div>
          )}
        </Card>
      )}

      {latest && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={t('updates.confirmTitle', { version: latest.version })}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" loading={install.isPending} onClick={() => install.mutate(latest.version)}>
                {t('updates.install', { version: latest.version })}
              </Button>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-muted">{t('updates.confirmBody')}</p>
        </Dialog>
      )}
    </div>
  );
}
