import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { AuthLayout } from '../AuthLayout.tsx';
import { ApiError, api, keys } from '../api.ts';

export function SetupScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;

  const setup = useMutation({
    mutationFn: () => api.setup(code, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.session }),
  });
  const codeError = setup.error instanceof ApiError && setup.error.code === 'wrong_code' ? t('setup.wrongCode') : null;

  return (
    <AuthLayout title={t('setup.title')}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) setup.mutate();
        }}
      >
        <p className="text-sm leading-relaxed text-muted">{t('setup.body')}</p>
        <Field
          label={t('setup.code')}
          autoFocus
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXXX-XXXXX"
          className="[&_input]:font-mono [&_input]:uppercase"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={codeError}
        />
        <Field
          label={t('setup.password')}
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label={t('setup.confirm')}
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={mismatch ? t('setup.mismatch') : setup.error && !codeError ? t('common.error') : null}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={setup.isPending}
          icon={<KeyRound className="size-4" />}
        >
          {t('setup.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
