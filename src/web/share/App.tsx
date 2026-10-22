import { CircleSlash, KeyRound, LinkIcon, MonitorX, ShieldCheck, TimerOff } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { formatDate } from '../lib/format.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import { Button } from '../ui/Button.tsx';
import { Card } from '../ui/Card.tsx';
import { Field } from '../ui/Field.tsx';
import { Logo } from '../ui/Logo.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { useDownloads } from './downloads.ts';
import { FileRow } from './FileRow.tsx';
import { type Grant, type LinkRef, openLink, readLink, unlockLink, verifierFor } from './link.ts';

type View =
  | { name: 'loading' }
  | { name: 'unsupported' }
  | { name: 'no-key' }
  | { name: 'unavailable' }
  | { name: 'busy' }
  | { name: 'password' }
  | { name: 'files'; grant: Grant };

const NO_PASSWORD_VERIFIER = 'A'.repeat(43);

// Kept in memory only: it unlocks this link, so it never touches browser storage.
let unlockedWith: string | null = null;

const supported = () =>
  typeof crypto !== 'undefined' &&
  !!crypto.subtle &&
  typeof TransformStream !== 'undefined' &&
  typeof ReadableStream !== 'undefined';

export function App() {
  const parsed = readLink(window.location);
  const [view, setView] = useState<View>(() =>
    !supported()
      ? { name: 'unsupported' }
      : parsed === null
        ? { name: 'unavailable' }
        : parsed === 'no-key'
          ? { name: 'no-key' }
          : { name: 'loading' },
  );
  const link = typeof parsed === 'object' && parsed ? parsed : null;

  useEffect(() => {
    if (!link || view.name !== 'loading') return;
    openLink(link)
      .then((result) => {
        if (result.kind === 'granted') setView({ name: 'files', grant: result.grant });
        else if (result.kind === 'password') setView({ name: 'password' });
        else if (result.kind === 'busy') setView({ name: 'busy' });
        else setView({ name: 'unavailable' });
      })
      .catch(() => setView({ name: 'unavailable' }));
  }, [link, view.name]);

  return (
    <main className="relative flex min-h-dvh flex-col items-center overflow-hidden px-4 pt-12 pb-10 sm:pt-20">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-72 left-1/2 size-[680px] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--accent),transparent)] opacity-20"
      />
      <div className="relative flex w-full max-w-lg flex-1 flex-col">
        <Brand />
        <div className="mt-8 flex-1">
          {view.name === 'loading' && (
            <div className="grid h-48 place-items-center text-muted">
              <Spinner className="size-6" />
            </div>
          )}
          {view.name === 'unsupported' && (
            <Notice icon={<MonitorX />} title="share.unsupportedTitle" body="share.unsupportedBody" />
          )}
          {view.name === 'no-key' && <Notice icon={<LinkIcon />} title="share.noKeyTitle" body="share.noKeyBody" />}
          {view.name === 'unavailable' && (
            <Notice icon={<TimerOff />} title="share.unavailableTitle" body="share.unavailableBody" />
          )}
          {view.name === 'busy' && <Notice icon={<CircleSlash />} title="share.tooManyRequests" body="share.busy" />}
          {view.name === 'password' && link && (
            <PasswordForm
              link={link}
              onGranted={(grant) => setView({ name: 'files', grant })}
              onUnavailable={() => setView({ name: 'unavailable' })}
            />
          )}
          {view.name === 'files' && link && <Files link={link} initial={view.grant} />}
        </div>
        <Footer />
      </div>
    </main>
  );
}

function Brand() {
  return (
    <div className="flex animate-enter items-center justify-center gap-2.5">
      <Logo className="size-9" />
      <span className="font-mono text-[15px] font-medium tracking-tight">pi-share</span>
    </div>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <div className="mt-10 flex flex-col items-center gap-2 text-center">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium">
        <ShieldCheck className="size-3.5 text-accent-strong" />
        End-to-end
      </span>
      <p className="max-w-sm text-xs leading-relaxed text-muted">{t('share.e2e')}</p>
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: 'share.unsupportedTitle' | 'share.noKeyTitle' | 'share.unavailableTitle' | 'share.tooManyRequests';
  body: 'share.unsupportedBody' | 'share.noKeyBody' | 'share.unavailableBody' | 'share.busy';
}) {
  const { t } = useI18n();
  return (
    <Card className="flex animate-enter flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted [&>svg]:size-6">{icon}</span>
      <h1 className="text-xl font-semibold tracking-tight">{t(title)}</h1>
      <p className="max-w-xs text-sm leading-relaxed text-muted">{t(body)}</p>
    </Card>
  );
}

function PasswordForm({
  link,
  onGranted,
  onUnavailable,
}: {
  link: LinkRef;
  onGranted: (grant: Grant) => void;
  onUnavailable: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Card className="animate-enter p-6">
      <form
        className="flex flex-col gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const verifier = await verifierFor(link, password);
            const result = await unlockLink(link, verifier);
            if (result.kind === 'granted') {
              unlockedWith = verifier;
              onGranted(result.grant);
            } else if (result.kind === 'wrong') setError(t('share.wrongPassword'));
            else if (result.kind === 'busy') setError(t('share.tooManyRequests'));
            else onUnavailable();
          } catch {
            setError(t('common.error'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid size-12 animate-pop place-items-center rounded-2xl bg-accent text-on-accent">
            <KeyRound className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">{t('share.passwordTitle')}</h1>
          <p className="text-sm text-muted">{t('share.passwordBody')}</p>
        </div>
        <Field
          label={t('create.password')}
          type="password"
          autoFocus
          required
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error}
        />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          {t('share.unlock')}
        </Button>
      </form>
    </Card>
  );
}

function Files({ link, initial }: { link: LinkRef; initial: Grant }) {
  const { t, lang } = useI18n();
  const [grant, setGrant] = useState(initial);
  const grantRef = useRef(grant);
  grantRef.current = grant;

  const refreshTicket = useCallback(async () => {
    const result = await unlockLink(link, unlockedWith ?? NO_PASSWORD_VERIFIER);
    if (result.kind !== 'granted') return null;
    setGrant(result.grant);
    return result.grant.ticket;
  }, [link]);

  const downloads = useDownloads(link, grant.ticket, refreshTicket);
  const { files, bundle, expiresAt } = grant.meta;
  const idle = { status: 'idle' } as const;
  const largest = Math.max(bundle?.size ?? 0, ...files.map((file) => file.size));

  return (
    <div className="flex animate-enter flex-col gap-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('share.title')}</h1>
        {expiresAt && (
          <p className="mt-2 text-sm text-muted">{t('share.expires', { date: formatDate(expiresAt, lang) })}</p>
        )}
      </div>

      <Card className="divide-y divide-line overflow-hidden">
        {files.map((file, position) => (
          <FileRow
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the file's identity inside the link
            key={`${position}-${file.name}`}
            name={file.name}
            size={file.size}
            available={file.available && downloads.ready}
            state={downloads.states[String(position)] ?? idle}
            onDownload={() => downloads.start({ part: position, name: file.name, size: file.size })}
          />
        ))}
      </Card>

      {bundle && (
        <Card className="overflow-hidden border-accent-strong/30">
          <FileRow
            highlight
            name={bundle.name}
            size={bundle.size}
            available={downloads.ready}
            state={downloads.states.all ?? idle}
            onDownload={() => downloads.start({ part: 'all', name: bundle.name, size: bundle.size })}
          />
        </Card>
      )}

      <p className="text-center text-xs text-muted">{t('share.keepOpen')}</p>
      {downloads.tooLargeForMemory(largest) && (
        <p className="text-center text-xs text-warn">{t('share.memoryWarning')}</p>
      )}
    </div>
  );
}
