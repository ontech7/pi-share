import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../lib/i18n-context.tsx';
import { Button } from '../ui/Button.tsx';
import { Dialog } from '../ui/Dialog.tsx';
import { Field } from '../ui/Field.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useToast } from '../ui/Toaster.tsx';
import { ApiError, api, keys } from './api.ts';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const service = useQuery({ queryKey: keys.service, queryFn: api.service });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const autoOff = useMutation({
    mutationFn: (value: boolean) => api.updateService({ autoOff: value }),
    onSuccess: (state) => queryClient.setQueryData(keys.service, state),
  });
  const changePassword = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      notify(t('settings.changed'));
    },
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.session }),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.title')} closeLabel={t('common.close')}>
      <div className="flex flex-col gap-8">
        <section className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('settings.autoOff')}</p>
            <p className="mt-1 font-mono text-xs break-all text-muted">{service.data?.publicUrl}</p>
          </div>
          <Switch
            checked={service.data?.autoOff ?? true}
            disabled={!service.data}
            onChange={(value) => autoOff.mutate(value)}
            label={t('settings.autoOff')}
          />
        </section>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            changePassword.mutate();
          }}
        >
          <h3 className="text-sm font-semibold">{t('settings.changePassword')}</h3>
          <Field
            label={t('settings.current')}
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            error={
              changePassword.error instanceof ApiError && changePassword.error.code === 'wrong_password'
                ? t('login.wrong')
                : null
            }
          />
          <Field
            label={t('settings.new')}
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Button type="submit" loading={changePassword.isPending} className="self-start">
            {t('common.save')}
          </Button>
        </form>

        <Button
          variant="danger"
          icon={<LogOut className="size-4" />}
          onClick={() => logout.mutate()}
          className="self-start"
        >
          {t('settings.logout')}
        </Button>
      </div>
    </Dialog>
  );
}
