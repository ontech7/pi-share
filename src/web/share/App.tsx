import {
  CirclePause,
  CircleSlash,
  KeyRound,
  LinkIcon,
  LockKeyhole,
  MonitorX,
  Network,
  ShieldCheck,
  TimerOff,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { RefusalReason } from '../../shared/api.ts';
import { formatDate } from '../lib/format.ts';
import type { MessageKey } from '../lib/i18n.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import { Button } from '../ui/Button.tsx';
import { Card } from '../ui/Card.tsx';
import { Field } from '../ui/Field.tsx';
import { Logo } from '../ui/Logo.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { useDownloads } from './downloads.ts';
import { FileRow } from './FileRow.tsx';
import { type Grant, type LinkRef, openLink, readLink, unlockLink, verifierFor } from './link.ts';
import { Tree } from './Tree.tsx';

type View =
  | { name: 'loading' }
  | { name: 'unsupported' }
  | { name: 'no-key' }
  | { name: 'unavailable'; reason?: RefusalReason }
  | { name: 'busy' }
  | { name: 'password' }
  | { name: 'files'; grant: Grant };

// Kept in memory only: it unlocks this link, so it never touches browser storage.
let unlockedWith: string | null = null;

const supported = () =>
  typeof crypto !== 'undefined' &&
  !!crypto.subtle &&
  typeof TransformStream !== 'undefined' &&
  typeof ReadableStream !== 'undefined';

const parsed = readLink(window.location);

export function App() {
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
        else setView({ name: 'unavailable', reason: result.kind === 'unavailable' ? result.reason : undefined });
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
          {view.name === 'unavailable' && <Unavailable reason={view.reason} />}
          {view.name === 'busy' && <Notice icon={<CircleSlash />} title="share.tooManyRequests" body="share.busy" />}
          {view.name === 'password' && link && (
            <PasswordForm
              link={link}
              onGranted={(grant) => setView({ name: 'files', grant })}
              onUnavailable={(reason) => setView({ name: 'unavailable', reason })}
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

const REASONS: Partial<Record<RefusalReason, { icon: ReactNode; title: MessageKey; body: MessageKey }>> = {
  paused: { icon: <CirclePause />, title: 'share.pausedTitle', body: 'share.pausedBody' },
  expired: { icon: <TimerOff />, title: 'share.unavailableTitle', body: 'share.expiredBody' },
  exhausted: { icon: <TimerOff />, title: 'share.unavailableTitle', body: 'share.exhaustedBody' },
  disabled: { icon: <CircleSlash />, title: 'share.unavailableTitle', body: 'share.disabledBody' },
  locked: { icon: <LockKeyhole />, title: 'share.unavailableTitle', body: 'share.lockedBody' },
  unavailable: { icon: <TimerOff />, title: 'share.unavailableTitle', body: 'share.goneBody' },
  network: { icon: <Network />, title: 'share.networkTitle', body: 'share.networkBody' },
};

/** Only someone holding the whole link learns the reason; anyone else gets the generic notice. */
function Unavailable({ reason }: { reason?: RefusalReason }) {
  const known = reason ? REASONS[reason] : undefined;
  return known ? (
    <Notice icon={known.icon} title={known.title} body={known.body} />
  ) : (
    <Notice icon={<TimerOff />} title="share.unavailableTitle" body="share.unavailableBody" />
  );
}

function Notice({ icon, title, body }: { icon: ReactNode; title: MessageKey; body: MessageKey }) {
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
  onUnavailable: (reason?: RefusalReason) => void;
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
            else onUnavailable(result.kind === 'unavailable' ? result.reason : undefined);
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
    const result = await unlockLink(link, unlockedWith ?? undefined);
    if (result.kind !== 'granted') return null;
    setGrant(result.grant);
    return result.grant.ticket;
  }, [link]);

  const downloads = useDownloads(link, grant.ticket, refreshTicket);
  const { entries, bundle, expiresAt } = grant.meta;
  const idle = { status: 'idle' } as const;
  const largest = entries.reduce((max, entry) => Math.max(max, entry.size), bundle?.size ?? 0);

  return (
    <div className="flex animate-enter flex-col gap-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('share.title')}</h1>
        {expiresAt && (
          <p className="mt-2 text-sm text-muted">{t('share.expires', { date: formatDate(expiresAt, lang) })}</p>
        )}
      </div>

      <Card className="divide-y divide-line overflow-hidden">
        <Tree
          entries={entries}
          ready={downloads.ready}
          states={downloads.states}
          onDownload={(entry) =>
            downloads.start({ part: entry.id, name: entry.path.split('/').at(-1) as string, size: entry.size })
          }
        />
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
