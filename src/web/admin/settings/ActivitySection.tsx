import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, Dices, RefreshCw, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  type NotificationChannel,
  type NotificationKind,
  type NotificationSettings,
  type NotificationsBody,
  notificationKinds,
  type ProviderInfo,
} from '../../../shared/api.ts';
import { formatDate } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { Field } from '../../ui/Field.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { Switch } from '../../ui/Switch.tsx';
import { useToast } from '../../ui/Toaster.tsx';
import { ApiError, api, keys } from '../api.ts';
import { SettingRow } from './Row.tsx';

const KIND_LABELS = {
  opens: 'notifications.opens',
  downloads: 'notifications.downloads',
  warnings: 'notifications.warnings',
  previews: 'notifications.previews',
} as const satisfies Record<NotificationKind, string>;

/** A topic nobody can guess: on ntfy.sh, whoever knows the topic reads its messages. */
const randomTopic = () =>
  `pi-share-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('')}`;

export function ActivitySection() {
  return (
    <div className="flex flex-col gap-4">
      <ProvidersCard />
      <NotificationsCard />
    </div>
  );
}

function Loading() {
  return (
    <Card className="grid h-40 place-items-center text-muted">
      <Spinner className="size-5" />
    </Card>
  );
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
  if (!info) return <Loading />;
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
                {t('providers.error', { error: info.error })}
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

type ChannelProps = {
  data: NotificationSettings;
  save: (patch: NotificationsBody, done?: () => void) => void;
  saving: boolean;
};

function NotificationsCard() {
  const { t, lang } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const notifications = useQuery({ queryKey: keys.notifications, queryFn: api.notifications });
  const set = (view: NotificationSettings) => queryClient.setQueryData(keys.notifications, view);
  const fail = (error: Error) =>
    notify(
      error instanceof ApiError && error.code === 'incomplete' ? t('notifications.incomplete') : t('common.error'),
      'error',
    );
  // Notifications are written in the language of the admin they were last set up in.
  const mutation = useMutation({
    mutationFn: (patch: NotificationsBody) => api.updateNotifications({ ...patch, lang }),
    onSuccess: set,
    onError: fail,
  });
  const save = (patch: NotificationsBody, done?: () => void) => mutation.mutate(patch, { onSuccess: () => done?.() });

  const data = notifications.data;
  if (!data) return <Loading />;
  const props = { data, save, saving: mutation.isPending };
  const anyChannel = data.ntfy.enabled || data.telegram.enabled || data.email.enabled;
  return (
    <>
      <NtfyCard {...props} />
      <TelegramCard {...props} />
      <EmailCard {...props} />
      <Card className="divide-y divide-line">
        <div className="px-4 py-4 sm:px-5">
          <p className="text-[15px] font-medium">{t('notifications.kinds')}</p>
          <p className="mt-1 text-sm text-muted">
            {anyChannel ? t('notifications.hint') : t('notifications.noChannel')}
          </p>
        </div>
        {notificationKinds.map((kind) => (
          <SettingRow key={kind} label={t(KIND_LABELS[kind])}>
            <Switch
              checked={data.kinds[kind]}
              disabled={!anyChannel}
              onChange={(on) => save({ kinds: { [kind]: on } })}
              label={t(KIND_LABELS[kind])}
            />
          </SettingRow>
        ))}
      </Card>
    </>
  );
}

/**
 * One channel: a switch, and below it what the channel needs. Turning on a channel that is not set up yet
 * only opens its form, with the switch still off; saving the form turns it on.
 */
function Channel({
  channel,
  data,
  ready,
  save,
  saving,
  dirty,
  clear,
  toPatch,
  children,
}: ChannelProps & {
  channel: NotificationChannel;
  ready: boolean;
  dirty: boolean;
  clear: () => void;
  toPatch: () => NotificationsBody;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const notify = useToast();
  const queryClient = useQueryClient();
  const enabled = data[channel].enabled;
  const [open, setOpen] = useState(enabled);
  const status = data.status[channel];
  const test = useMutation({
    mutationFn: () => api.testNotification(channel),
    onSuccess: (view) => {
      queryClient.setQueryData(keys.notifications, view);
      notify(t('notifications.testSent'));
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: keys.notifications });
      notify(t('notifications.testFailed'), 'error');
    },
  });
  const title = t(`notifications.${channel}`);
  const label = t('notifications.via', { channel: title });

  return (
    <Card className="divide-y divide-line">
      <SettingRow
        label={title}
        hint={open && !enabled ? t('notifications.saveToEnable') : t(`notifications.${channel}Hint`)}
      >
        <Switch
          checked={enabled}
          label={label}
          onChange={(on) => {
            setOpen(on);
            if (on && ready) save({ [channel]: { enabled: true } });
            if (!on && enabled) save({ [channel]: { enabled: false } });
          }}
        />
      </SettingRow>
      {(enabled || open) && (
        <form
          className="animate-enter flex flex-col gap-4 px-4 py-4 sm:px-5"
          onSubmit={(event) => {
            event.preventDefault();
            save({ ...toPatch(), [channel]: { ...toPatch()[channel], enabled: true } }, () => {
              clear();
              notify(t('settings.saved'));
            });
          }}
        >
          {children}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty && enabled}>
              {t('common.save')}
            </Button>
            <Button
              icon={<Send className="size-4" />}
              loading={test.isPending}
              disabled={dirty || !ready}
              onClick={() => test.mutate()}
            >
              {t('notifications.test')}
            </Button>
          </div>
          {status.lastError && (
            <p className="flex items-start gap-1.5 text-sm break-words text-danger" role="status">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {t('notifications.lastError', { error: status.lastError })}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}

/** A secret field: empty keeps the saved one, which is never shown again. */
function SecretField({
  label,
  saved,
  value,
  onChange,
  onRemove,
  hint,
}: {
  label: string;
  saved: boolean;
  value: string;
  onChange: (value: string) => void;
  onRemove?: () => void;
  hint?: string;
}) {
  const { t } = useI18n();
  return (
    <Field
      label={label}
      hint={saved ? t('notifications.secretSaved') : hint}
      type="password"
      autoComplete="off"
      placeholder={saved ? '••••••••' : ''}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      trailing={
        saved &&
        !value &&
        onRemove && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            {t('notifications.secretRemove')}
          </Button>
        )
      }
    />
  );
}

function NtfyCard(props: ChannelProps) {
  const { t } = useI18n();
  const { ntfy } = props.data;
  const saved = { server: ntfy.server, topic: ntfy.topic, token: '' };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const form = draft ?? saved;
  const edit = (patch: Partial<typeof saved>) => setDraft({ ...form, ...patch });
  return (
    <Channel
      {...props}
      channel="ntfy"
      ready={!!ntfy.topic}
      dirty={draft !== null}
      clear={() => setDraft(null)}
      toPatch={() => ({
        ntfy: { server: form.server.trim(), topic: form.topic, ...(form.token.trim() && { token: form.token.trim() }) },
      })}
    >
      <Field
        label={t('notifications.server')}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={form.server}
        onChange={(event) => edit({ server: event.target.value })}
      />
      <Field
        label={t('notifications.topic')}
        hint={t('notifications.topicHint')}
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        required
        className="[&_input]:font-mono"
        value={form.topic}
        onChange={(event) => edit({ topic: event.target.value.replace(/[^\w-]/g, '') })}
        trailing={
          <Button
            size="sm"
            variant="ghost"
            icon={<Dices className="size-4" />}
            onClick={() => edit({ topic: randomTopic() })}
          >
            {t('create.generate')}
          </Button>
        }
      />
      <SecretField
        label={t('notifications.token')}
        hint={t('notifications.tokenHint')}
        saved={ntfy.hasToken}
        value={form.token}
        onChange={(token) => edit({ token })}
        onRemove={() => props.save({ ntfy: { token: null } })}
      />
    </Channel>
  );
}

function TelegramCard(props: ChannelProps) {
  const { t } = useI18n();
  const { telegram } = props.data;
  const saved = { token: '', chatId: telegram.chatId };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const form = draft ?? saved;
  const edit = (patch: Partial<typeof saved>) => setDraft({ ...form, ...patch });
  return (
    <Channel
      {...props}
      channel="telegram"
      ready={telegram.hasToken && !!telegram.chatId}
      dirty={draft !== null}
      clear={() => setDraft(null)}
      toPatch={() => ({
        telegram: { chatId: form.chatId.trim(), ...(form.token.trim() && { token: form.token.trim() }) },
      })}
    >
      <SecretField
        label={t('notifications.botToken')}
        hint={t('notifications.botTokenHint')}
        saved={telegram.hasToken}
        value={form.token}
        onChange={(token) => edit({ token })}
      />
      <Field
        label={t('notifications.chatId')}
        hint={t('notifications.chatIdHint')}
        autoComplete="off"
        spellCheck={false}
        required
        className="[&_input]:font-mono"
        value={form.chatId}
        onChange={(event) => edit({ chatId: event.target.value })}
      />
    </Channel>
  );
}

const SECURITY = [
  { value: 'starttls', label: 'STARTTLS', port: 587 },
  { value: 'tls', label: 'TLS', port: 465 },
  { value: 'none', label: 'notifications.securityNone', port: 25 },
] as const;

function EmailCard(props: ChannelProps) {
  const { t } = useI18n();
  const { email } = props.data;
  const saved = {
    host: email.host,
    port: String(email.port),
    security: email.security as string,
    user: email.user,
    password: '',
    from: email.from,
    to: email.to,
  };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const form = draft ?? saved;
  const edit = (patch: Partial<typeof saved>) => setDraft({ ...form, ...patch });
  return (
    <Channel
      {...props}
      channel="email"
      ready={!!email.host && !!email.from && !!email.to}
      dirty={draft !== null}
      clear={() => setDraft(null)}
      toPatch={() => ({
        email: {
          host: form.host.trim(),
          port: Number(form.port) || 587,
          security: form.security as NotificationSettings['email']['security'],
          user: form.user.trim(),
          from: form.from.trim(),
          to: form.to.trim(),
          ...(form.password && { password: form.password }),
        },
      })}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
        <Field
          label={t('notifications.host')}
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="smtp.example.com"
          value={form.host}
          onChange={(event) => edit({ host: event.target.value })}
        />
        <Field
          label={t('notifications.port')}
          type="number"
          inputMode="numeric"
          min={1}
          max={65535}
          required
          value={form.port}
          onChange={(event) => edit({ port: event.target.value.replace(/\D/g, '') })}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t('notifications.security')}</legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
          {SECURITY.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={form.security === option.value}
              onClick={() => edit({ security: option.value, port: String(option.port) })}
              className={clsx(
                'press h-10 rounded-lg text-sm font-medium transition-colors',
                form.security === option.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              {option.value === 'none' ? t(option.label) : option.label}
            </button>
          ))}
        </div>
        {form.security === 'none' && <p className="text-sm text-warn">{t('notifications.securityNoneHint')}</p>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('notifications.user')}
          autoComplete="off"
          spellCheck={false}
          value={form.user}
          onChange={(event) => edit({ user: event.target.value })}
        />
        <SecretField
          label={t('notifications.password')}
          saved={email.hasPassword}
          value={form.password}
          onChange={(password) => edit({ password })}
          onRemove={() => props.save({ email: { password: null } })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('notifications.from')}
          type="email"
          autoComplete="off"
          required
          value={form.from}
          onChange={(event) => edit({ from: event.target.value })}
        />
        <Field
          label={t('notifications.to')}
          type="email"
          autoComplete="off"
          required
          value={form.to}
          onChange={(event) => edit({ to: event.target.value })}
        />
      </div>
      <p className="text-sm text-muted">{t('notifications.emailHint2')}</p>
    </Channel>
  );
}
