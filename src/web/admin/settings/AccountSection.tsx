import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { Field } from '../../ui/Field.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { ApiError, api, keys } from '../api.ts';
import { SettingRow } from './Row.tsx';

export function AccountSection() {
  const { t } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

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
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            changePassword.mutate();
          }}
        >
          <h3 className="text-[15px] font-medium">{t('settings.changePassword')}</h3>
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
          <Button type="submit" variant="primary" loading={changePassword.isPending} className="self-start">
            {t('common.save')}
          </Button>
        </form>
      </Card>
      <Card>
        <SettingRow label={t('settings.logout')} hint={t('settings.logoutHint')}>
          <Button variant="danger" size="sm" icon={<LogOut className="size-4" />} onClick={() => logout.mutate()}>
            {t('settings.logout')}
          </Button>
        </SettingRow>
      </Card>
    </div>
  );
}
