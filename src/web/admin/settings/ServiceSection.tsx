import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Card } from '../../ui/Card.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { api, keys } from '../api.ts';
import { useService } from '../ServiceToggle.tsx';
import { SettingRow } from './Row.tsx';

export function ServiceSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { service, toggle } = useService();
  const autoOff = useMutation({
    mutationFn: (value: boolean) => api.updateService({ autoOff: value }),
    onSuccess: (state) => queryClient.setQueryData(keys.service, state),
  });
  const state = service.data;

  return (
    <Card className="divide-y divide-line">
      <SettingRow label={t('settings.serviceOn')} hint={t('settings.serviceOnHint')}>
        <Switch
          checked={state?.enabled ?? false}
          disabled={!state}
          onChange={(enabled) => toggle.mutate(enabled)}
          label={t('settings.serviceOn')}
        />
      </SettingRow>
      <SettingRow label={t('settings.autoOff')} hint={t('settings.autoOffHint')}>
        <Switch
          checked={state?.autoOff ?? true}
          disabled={!state}
          onChange={(value) => autoOff.mutate(value)}
          label={t('settings.autoOff')}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.publicUrl')}
        hint={
          <>
            {t('settings.publicUrlHint')}
            <span className="mt-1 block font-mono text-xs break-all text-fg">{state?.publicUrl}</span>
          </>
        }
      >
        {state && (
          <CopyButton value={state.publicUrl} label={t('common.copy')} copiedLabel={t('common.copied')} size="sm" />
        )}
      </SettingRow>
    </Card>
  );
}
