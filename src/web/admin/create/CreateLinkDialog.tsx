import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Dices, Folder, Link2, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { BrowseEntry, ChangePolicy, LinkDetail, Preferences } from '../../../shared/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Button } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { Field } from '../../ui/Field.tsx';
import { ApiError, api, keys } from '../api.ts';
import { FilePicker } from './FilePicker.tsx';
import { PolicyPicker } from './PolicyPicker.tsx';
import { generatePassword } from './password.ts';

export const EXPIRY_PRESETS = [
  { days: 1, key: 'create.expiry1' },
  { days: 7, key: 'create.expiry7' },
  { days: 30, key: 'create.expiry30' },
  { days: 0, key: 'create.expiryNever' },
] as const;

type Step = 'files' | 'options' | 'done';

export function CreateLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<Step>('files');
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState(new Map<string, BrowseEntry>());
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expiryDays, setExpiryDays] = useState(7);
  const [maxDownloads, setMaxDownloads] = useState('');
  const [sensitive, setSensitive] = useState<string[] | null>(null);
  const [onChange, setOnChange] = useState<ChangePolicy>('pause');
  const [created, setCreated] = useState<LinkDetail | null>(null);
  const preferences = useQuery({ queryKey: keys.preferences, queryFn: api.preferences, enabled: open });

  const applyPreferences = (defaults: Preferences) => {
    setPassword(defaults.generatePassword ? generatePassword() : '');
    setExpiryDays(defaults.expiryDays);
    setMaxDownloads(defaults.maxDownloads ? String(defaults.maxDownloads) : '');
    setOnChange(defaults.onChange);
  };

  // Every new link starts from the saved preferences; reopening the dialog starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens or the preferences arrive
  useEffect(() => {
    if (open && preferences.data) applyPreferences(preferences.data);
  }, [open, preferences.data]);

  const reset = () => {
    setStep('files');
    setSelected(new Map());
    setLabel('');
    setSensitive(null);
    setCreated(null);
  };

  const close = () => {
    onClose();
    setTimeout(reset, 200);
  };

  const create = useMutation({
    mutationFn: (confirmSensitive: boolean) =>
      api.createLink({
        paths: [...selected.keys()],
        label,
        password: password || undefined,
        expiresAt: expiryDays ? Date.now() + expiryDays * 86_400_000 : null,
        maxDownloads: maxDownloads ? Number(maxDownloads) : null,
        onChange,
        confirmSensitive,
      }),
    onSuccess: (link) => {
      setCreated(link);
      setStep('done');
      queryClient.invalidateQueries({ queryKey: keys.links });
      queryClient.invalidateQueries({ queryKey: keys.service });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'sensitive') setSensitive(error.data.files as string[]);
    },
  });

  const toggle = (entry: BrowseEntry) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });

  const totalSize = [...selected.values()].reduce((sum, entry) => sum + entry.size, 0);
  const hasFolders = [...selected.values()].some((entry) => entry.type === 'dir');
  const steps: Step[] = ['files', 'options', 'done'];

  const footer =
    step === 'files' ? (
      <>
        {selected.size > 0 && (
          <Button variant="ghost" onClick={() => setSelected(new Map())} className="mr-auto">
            {t('create.clear')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={selected.size === 0}
          onClick={() => setStep('options')}
          icon={<ArrowRight className="size-4" />}
        >
          {t('create.next')}
        </Button>
      </>
    ) : step === 'options' ? (
      <>
        <Button
          variant="ghost"
          icon={<ArrowLeft className="size-4" />}
          onClick={() => setStep('files')}
          className="mr-auto"
        >
          {t('common.back')}
        </Button>
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={password.length > 0 && password.length < 4}
          icon={<Link2 className="size-4" />}
          onClick={() => create.mutate(false)}
        >
          {t('create.submit')}
        </Button>
      </>
    ) : (
      <Button
        variant="secondary"
        onClick={() => {
          if (created) navigate(`/links/${created.id}`);
          close();
        }}
      >
        {t('common.close')}
      </Button>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      closeLabel={t('common.close')}
      footer={footer}
      title={
        <span className="flex items-center gap-3">
          {step === 'done' ? t('create.doneTitle') : t('create.title')}
          <span className="flex gap-1" aria-hidden="true">
            {steps.map((s) => (
              <span
                key={s}
                className={clsx(
                  'h-1.5 rounded-full transition-[width,background-color] duration-300',
                  s === step ? 'w-5 bg-accent' : 'w-1.5 bg-line',
                )}
              />
            ))}
          </span>
        </span>
      }
    >
      {step === 'files' && (
        <div className="flex flex-col gap-4">
          <FilePicker path={path} onNavigate={setPath} selected={selected} onToggle={toggle} />
          {selected.size > 0 && (
            <div className="animate-enter flex flex-col gap-2">
              <p className="text-sm text-muted tabular">
                {selected.size === 1 ? t('create.selectedOne') : t('create.selected', { n: selected.size })}
                {!hasFolders && ` · ${formatBytes(totalSize, lang)}`}
              </p>
              <ul className="flex flex-wrap gap-2">
                {[...selected.values()].map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => toggle(entry)}
                      title={entry.path}
                      className="press flex max-w-64 items-center gap-1.5 rounded-full bg-surface-2 py-1 pr-2 pl-3 text-sm hover:bg-line"
                    >
                      {entry.type === 'dir' && <Folder className="size-3.5 shrink-0 text-accent-strong" />}
                      <span className="truncate">{entry.name}</span>
                      <X className="size-3.5 shrink-0 text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {step === 'options' && (
        <div className="animate-enter flex flex-col gap-6">
          <Field
            label={t('create.label')}
            placeholder={t('create.labelPlaceholder')}
            maxLength={120}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Field
            label={t('create.password')}
            hint={t('create.passwordHint')}
            value={password}
            autoComplete="off"
            spellCheck={false}
            className="[&_input]:font-mono"
            onChange={(event) => setPassword(event.target.value)}
            trailing={
              <Button
                size="sm"
                variant="ghost"
                icon={<Dices className="size-4" />}
                onClick={() => setPassword(generatePassword())}
              >
                {t('create.generate')}
              </Button>
            }
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t('create.expiry')}</legend>
            <ExpiryPicker value={expiryDays} onChange={setExpiryDays} />
          </fieldset>
          <Field
            label={t('create.maxDownloads')}
            hint={t('create.maxDownloadsHint')}
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            placeholder={t('create.unlimited')}
            value={maxDownloads}
            onChange={(event) => setMaxDownloads(event.target.value.replace(/\D/g, ''))}
          />
          <PolicyPicker value={onChange} onChange={setOnChange} />
          {create.isError && !sensitive && (
            <p className="text-sm text-danger" role="alert">
              {t('common.error')}
            </p>
          )}
          {sensitive && (
            <div className="animate-enter flex flex-col gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-4">
              <p className="flex items-center gap-2 font-semibold text-warn">
                <ShieldAlert className="size-5" />
                {t('create.sensitiveTitle')}
              </p>
              <p className="text-sm">{t('create.sensitiveBody')}</p>
              <ul className="font-mono text-xs text-muted">
                {sensitive.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              <Button
                variant="danger"
                className="self-start"
                loading={create.isPending}
                onClick={() => create.mutate(true)}
              >
                {t('create.sensitiveConfirm')}
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 'done' && created && (
        <div className="animate-pop flex flex-col gap-5">
          <div className="rounded-2xl border border-accent-strong/30 bg-accent/10 p-4">
            <p className="font-mono text-sm break-all select-all">{created.url}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton
              value={created.url}
              label={t('actions.copyLink')}
              copiedLabel={t('common.copied')}
              variant="primary"
              size="lg"
            />
            {password && (
              <CopyButton
                value={password}
                label={`${t('common.copy')} ${t('create.password').toLowerCase()}`}
                copiedLabel={t('common.copied')}
                size="lg"
              />
            )}
          </div>
          {password && <p className="text-sm text-muted">{t('create.doneHint')}</p>}
        </div>
      )}
    </Dialog>
  );
}

export function ExpiryPicker({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1">
      {EXPIRY_PRESETS.map((preset) => (
        <button
          key={preset.days}
          type="button"
          aria-pressed={value === preset.days}
          onClick={() => onChange(preset.days)}
          className={clsx(
            'press h-9 rounded-lg text-sm font-medium transition-colors',
            value === preset.days ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {t(preset.key)}
        </button>
      ))}
    </div>
  );
}
