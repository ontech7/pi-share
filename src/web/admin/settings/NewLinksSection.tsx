import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Preferences } from '../../../shared/api.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Card } from '../../ui/Card.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { api, keys } from '../api.ts';
import { ExpiryPicker } from '../create/CreateLinkDialog.tsx';
import { PolicyPicker } from '../create/PolicyPicker.tsx';
import { SettingRow } from './Row.tsx';

export function NewLinksSection() {
  const { t } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: keys.preferences, queryFn: api.preferences });
  const [limit, setLimit] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Partial<Preferences>) => api.updatePreferences(patch),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.preferences, saved);
      notify(t('settings.saved'));
    },
    onError: () => notify(t('common.error'), 'error'),
  });

  const data = preferences.data;
  if (!data) {
    return (
      <Card className="grid h-40 place-items-center text-muted">
        <Spinner className="size-5" />
      </Card>
    );
  }
  const shownLimit = limit ?? (data.maxDownloads ? String(data.maxDownloads) : '');
  const saveLimit = () => {
    if (limit === null) return;
    const value = limit ? Math.min(Number(limit), 10_000) : null;
    save.mutate({ maxDownloads: value || null }, { onSettled: () => setLimit(null) });
  };

  return (
    <Card className="divide-y divide-line">
      <div className="px-4 py-4 sm:px-5">
        <PolicyPicker value={data.onChange} onChange={(onChange) => save.mutate({ onChange })} />
      </div>
      <SettingRow label={t('create.expiry')} stacked>
        <ExpiryPicker value={data.expiryDays} onChange={(expiryDays) => save.mutate({ expiryDays })} />
      </SettingRow>
      <SettingRow label={t('create.maxDownloads')} hint={t('create.maxDownloadsHint')}>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          aria-label={t('create.maxDownloads')}
          placeholder={t('create.unlimited')}
          value={shownLimit}
          onChange={(event) => setLimit(event.target.value.replace(/\D/g, ''))}
          onBlur={saveLimit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className="h-10 w-28 rounded-xl border border-line bg-surface-2 px-3 text-right text-sm tabular outline-none focus:border-accent-strong"
        />
      </SettingRow>
      <SettingRow label={t('settings.generatePassword')}>
        <Switch
          checked={data.generatePassword}
          onChange={(generatePassword) => save.mutate({ generatePassword })}
          label={t('settings.generatePassword')}
        />
      </SettingRow>
    </Card>
  );
}
