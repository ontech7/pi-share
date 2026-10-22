import clsx from 'clsx';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  trailing?: ReactNode;
};

export function Field({ label, hint, error, trailing, className, id, ...rest }: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-fg">
        {label}
      </label>
      <div
        className={clsx(
          'flex items-center gap-2 rounded-xl border bg-surface px-3 transition-colors focus-within:border-accent-strong',
          error ? 'border-danger' : 'border-line',
        )}
      >
        <input
          id={inputId}
          aria-invalid={!!error}
          {...rest}
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted/70"
        />
        {trailing}
      </div>
      {error ? (
        <p className="animate-enter text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
