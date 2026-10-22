import type { FileState, LinkState } from '../../shared/api.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import { Badge, type Tone } from '../ui/Badge.tsx';

const LINK_TONES: Record<LinkState, Tone> = {
  active: 'ok',
  disabled: 'muted',
  expired: 'muted',
  locked: 'danger',
  exhausted: 'warn',
  unavailable: 'warn',
};

const FILE_TONES: Record<FileState, Tone> = { ok: 'ok', changed: 'warn', missing: 'danger' };

export function LinkStateBadge({ state }: { state: LinkState }) {
  const { t } = useI18n();
  return (
    <Badge tone={LINK_TONES[state]} pulse={state === 'active'}>
      {t(`state.${state}`)}
    </Badge>
  );
}

export function FileStateBadge({ state }: { state: FileState }) {
  const { t } = useI18n();
  return <Badge tone={FILE_TONES[state]}>{t(`file.${state}`)}</Badge>;
}
