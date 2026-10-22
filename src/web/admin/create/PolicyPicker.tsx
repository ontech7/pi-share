import clsx from 'clsx';
import { CirclePause, RefreshCw } from 'lucide-react';
import type { ChangePolicy } from '../../../shared/api.ts';
import { useI18n } from '../../lib/i18n-context.tsx';

const OPTIONS = [
  { value: 'pause', icon: CirclePause, label: 'create.onChangePause', hint: 'create.onChangePauseHint' },
  { value: 'follow', icon: RefreshCw, label: 'create.onChangeFollow', hint: 'create.onChangeFollowHint' },
] as const;

export function PolicyPicker({ value, onChange }: { value: ChangePolicy; onChange: (value: ChangePolicy) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{t('create.onChange')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map(({ value: option, icon: Icon, label, hint }) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option)}
              className={clsx(
                'press flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors',
                selected ? 'border-accent-strong/50 bg-accent/10' : 'border-line hover:bg-surface-2',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className={clsx('size-4', selected ? 'text-accent-strong' : 'text-muted')} />
                {t(label)}
              </span>
              <span className="text-xs leading-relaxed text-muted">{t(hint)}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
