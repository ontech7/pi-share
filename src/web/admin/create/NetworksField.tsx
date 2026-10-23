import clsx from 'clsx';
import { useId, useState } from 'react';
import { MAX_NETWORKS, parseNetwork } from '../../../shared/api.ts';
import { useI18n } from '../../lib/i18n-context.tsx';

/** One network per line (or separated by commas); empty lines are ignored. */
export function splitNetworks(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The lines that are not an address or a range, or a note when there are too many. */
export function networksProblem(text: string): string[] | 'too_many' | null {
  const lines = splitNetworks(text);
  if (lines.length > MAX_NETWORKS) return 'too_many';
  const invalid = lines.filter((line) => parseNetwork(line) === null);
  return invalid.length ? invalid : null;
}

export function NetworksField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  // Judged once the field is left, so a range half typed is not shown as a mistake.
  const [touched, setTouched] = useState(false);
  const problem = touched ? networksProblem(value) : null;
  const error =
    problem === 'too_many'
      ? t('networks.tooMany', { max: MAX_NETWORKS })
      : problem
        ? t('networks.invalid', { lines: problem.join(', ') })
        : null;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {t('networks.label')}
      </label>
      <textarea
        id={id}
        value={value}
        rows={2}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('networks.placeholder')}
        aria-invalid={!!error}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setTouched(true)}
        className={clsx(
          'min-h-11 resize-y rounded-xl border bg-surface px-3 py-2.5 font-mono text-sm outline-none transition-colors placeholder:font-sans placeholder:text-muted/70 focus:border-accent-strong',
          error ? 'border-danger' : 'border-line',
        )}
      />
      <p
        id={`${id}-hint`}
        className={clsx('text-sm break-words', error ? 'text-danger' : 'text-muted')}
        aria-live="polite"
      >
        {error ?? t('networks.hint')}
      </p>
    </div>
  );
}
