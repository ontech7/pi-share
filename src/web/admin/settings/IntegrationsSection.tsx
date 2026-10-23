import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type CreatedToken, MAX_TOKENS, type TokenView } from '../../../shared/api.ts';
import { formatDate, formatRelative } from '../../lib/format.ts';
import type { MessageKey } from '../../lib/i18n.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Badge } from '../../ui/Badge.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Field } from '../../ui/Field.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { api, keys } from '../api.ts';
import { ExpiryPicker } from '../create/CreateLinkDialog.tsx';

const TOKEN_EXPIRY: { days: number; key: MessageKey }[] = [
  { days: 30, key: 'create.expiry30' },
  { days: 90, key: 'tokens.expiry90' },
  { days: 365, key: 'tokens.expiry365' },
  { days: 0, key: 'create.expiryNever' },
];

export function IntegrationsSection() {
  const { t } = useI18n();
  const tokens = useQuery({ queryKey: keys.tokens, queryFn: api.tokens });
  const [created, setCreated] = useState<CreatedToken | null>(null);

  if (!tokens.data) {
    return (
      <Card className="grid h-40 place-items-center text-muted">
        <Spinner className="size-5" />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {created ? (
        <NewToken token={created} onDone={() => setCreated(null)} />
      ) : (
        <CreateToken full={tokens.data.length >= MAX_TOKENS} onCreated={setCreated} />
      )}
      <Card className="divide-y divide-line">
        {tokens.data.length ? (
          tokens.data.map((token) => <TokenRow key={token.id} token={token} />)
        ) : (
          <p className="px-4 py-6 text-center text-sm text-muted sm:px-5">{t('tokens.empty')}</p>
        )}
      </Card>
      <p className="text-sm text-muted">
        {t('tokens.usage')}{' '}
        <code className="font-mono text-xs whitespace-nowrap text-fg">Authorization: Bearer pis_…</code>
      </p>
    </div>
  );
}

function CreateToken({ full, onCreated }: { full: boolean; onCreated: (token: CreatedToken) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const create = useMutation({
    mutationFn: () => api.createToken({ name: name.trim(), expiresAt: days ? Date.now() + days * 86_400_000 : null }),
    onSuccess: (token) => {
      setName('');
      onCreated(token);
      queryClient.invalidateQueries({ queryKey: keys.tokens });
    },
  });

  return (
    <Card className="p-4 sm:p-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <h3 className="text-[15px] font-medium">{t('tokens.new')}</h3>
        <Field
          label={t('tokens.name')}
          hint={t('tokens.nameHint')}
          placeholder="pi-agent"
          maxLength={60}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t('create.expiry')}</p>
          <ExpiryPicker value={days} onChange={setDays} presets={TOKEN_EXPIRY} />
          {days === 0 && (
            <p className="flex animate-enter gap-2 text-sm text-warn">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {t('tokens.neverWarning')}
            </p>
          )}
        </div>
        {full && <p className="text-sm text-warn">{t('tokens.full', { n: MAX_TOKENS })}</p>}
        {create.isError && (
          <p className="text-sm text-danger" role="alert">
            {t('common.error')}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          icon={<Plus className="size-4" />}
          loading={create.isPending}
          disabled={full}
          className="self-start"
        >
          {t('tokens.create')}
        </Button>
      </form>
    </Card>
  );
}

function NewToken({ token, onDone }: { token: CreatedToken; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <Card className="flex animate-enter flex-col gap-3 p-4 ring-1 ring-accent-strong/30 sm:p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-accent-strong" />
        <h3 className="min-w-0 text-[15px] font-medium break-words">
          {t('tokens.createdTitle', { name: token.name })}
        </h3>
      </div>
      <p className="text-sm text-muted">{t('tokens.createdHint')}</p>
      <code className="break-all rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-sm select-all">
        {token.token}
      </code>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={token.token} label={t('common.copy')} copiedLabel={t('common.copied')} variant="primary" />
        <Button variant="ghost" onClick={onDone}>
          {t('tokens.done')}
        </Button>
      </div>
    </Card>
  );
}

function TokenRow({ token }: { token: TokenView }) {
  const { t, lang } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.deleteToken(token.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.tokens });
      notify(t('tokens.revoked'));
    },
    onError: () => notify(t('common.error'), 'error'),
  });
  const expired = token.expiresAt !== null && token.expiresAt <= Date.now();

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[15px] font-medium">{token.name}</p>
          {expired ? (
            <Badge tone="danger">{t('state.expired')}</Badge>
          ) : token.expiresAt === null ? (
            <Badge tone="warn">{t('tokens.neverExpires')}</Badge>
          ) : null}
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted">
          <span className="font-mono text-xs leading-5">pis_…{token.hint}</span>
          {token.expiresAt !== null && !expired && (
            <span>
              {t('detail.expires')} {formatDate(token.expiresAt, lang)}
            </span>
          )}
          <span>
            {token.lastUsedAt === null
              ? t('tokens.neverUsed')
              : Date.now() - token.lastUsedAt < 60_000
                ? t('tokens.usedJustNow')
                : t('tokens.lastUsed', { when: formatRelative(token.lastUsedAt, lang) })}
          </span>
        </p>
      </div>
      <Button
        variant="danger"
        size="sm"
        icon={<Trash2 className="size-4" />}
        loading={revoke.isPending}
        onClick={() => {
          if (window.confirm(t('tokens.revokeConfirm', { name: token.name }))) revoke.mutate();
        }}
      >
        {t('tokens.revoke')}
      </Button>
    </div>
  );
}
