import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { ServiceState } from '../../shared/api.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import { Switch } from '../ui/Switch.tsx';
import { api, keys } from './api.ts';

/** The service state and an optimistic switch for it, shared by the header and the settings. */
export function useService() {
  const queryClient = useQueryClient();
  const service = useQuery({ queryKey: keys.service, queryFn: api.service, refetchInterval: 10_000 });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateService({ enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: keys.service });
      const previous = queryClient.getQueryData<ServiceState>(keys.service);
      if (previous) queryClient.setQueryData(keys.service, { ...previous, enabled });
      return { previous };
    },
    onError: (_error, _enabled, context) => queryClient.setQueryData(keys.service, context?.previous),
    onSuccess: (state) => queryClient.setQueryData(keys.service, state),
  });
  return { service, toggle };
}

export function ServiceToggle() {
  const { t } = useI18n();
  const { service, toggle } = useService();
  const state = service.data;
  if (!state) return <div className="h-10 w-36 rounded-full bg-surface-2" />;

  const paused = state.enabled && !state.online;
  const tone = state.online ? 'text-ok' : paused ? 'text-warn' : 'text-muted';
  const label = state.online ? t('service.online') : paused ? t('service.paused') : t('service.offline');

  return (
    <div className="flex items-center gap-3 rounded-full border border-line bg-surface py-1 pr-1 pl-3.5">
      <span className={clsx('flex items-center gap-2 text-sm font-medium', tone)}>
        <span className="relative flex size-2">
          {state.online && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />}
          <span className="relative size-2 rounded-full bg-current" />
        </span>
        <span className="max-sm:sr-only">{label}</span>
      </span>
      <Switch
        checked={state.enabled}
        onChange={(enabled) => toggle.mutate(enabled)}
        label={state.enabled ? t('service.turnOff') : t('service.turnOn')}
      />
    </div>
  );
}
