import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { AuthLayout } from '../AuthLayout.tsx';
import { ApiError, api, keys } from '../api.ts';

export function LoginScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.session }),
  });

  const error = login.error
    ? login.error instanceof ApiError && login.error.status === 429
      ? t('login.tooMany')
      : login.error instanceof ApiError && login.error.code === 'wrong_password'
        ? t('login.wrong')
        : t('common.error')
    : null;

  return (
    <AuthLayout title={t('login.title')}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <Field
          label={t('login.password')}
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={login.isPending}
          icon={<ArrowRight className="size-4" />}
        >
          {t('login.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
