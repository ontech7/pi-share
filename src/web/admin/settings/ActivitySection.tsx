import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RefreshCw } from 'lucide-react';
import type { ProviderInfo } from '../../../shared/api.ts';
import { formatDate } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { api, keys } from '../api.ts';
import { SettingRow } from './Row.tsx';
import { describeRemote } from './remote.ts';

export function ActivitySection() {
  return <ProvidersCard />;
}

function ProvidersCard() {
  const { t, lang } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const set = (info: ProviderInfo) => queryClient.setQueryData(keys.providers, info);
  const providers = useQuery({
    queryKey: keys.providers,
    queryFn: api.providers,
    refetchInterval: (query) => (query.state.data?.updating ? 2_000 : false),
  });
  const onError = () => notify(t('common.error'), 'error');
  const toggle = useMutation({ mutationFn: api.setProviders, onSuccess: set, onError });
  const refresh = useMutation({ mutationFn: api.refreshProviders, onSuccess: set, onError });

  const info = providers.data;
  if (!info) {
    return (
      <Card className="grid h-40 place-items-center text-muted">
        <Spinner className="size-5" />
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-line">
      <SettingRow label={t('providers.title')} hint={t('providers.hint')}>
        <Switch checked={info.enabled} onChange={(enabled) => toggle.mutate(enabled)} label={t('providers.title')} />
      </SettingRow>
      {info.enabled && (
        <SettingRow
          label={t('providers.table')}
          hint={
            info.updating ? (
              t('providers.updating')
            ) : info.error ? (
              <span className="flex items-center gap-1.5 text-danger">
                <CircleAlert className="size-4 shrink-0" />
                {t('providers.error', { error: describeRemote(t, info.error) })}
              </span>
            ) : info.updatedAt ? (
              t('providers.updated', {
                n: info.ranges.toLocaleString(lang),
                date: formatDate(info.updatedAt, lang),
              })
            ) : (
              t('providers.missing')
            )
          }
        >
          <Button
            size="sm"
            icon={<RefreshCw className="size-4" />}
            loading={info.updating || refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {t('providers.refresh')}
          </Button>
        </SettingRow>
      )}
    </Card>
  );
}
