import clsx from 'clsx';

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
};

export function Switch({ checked, onChange, label, disabled, size = 'md' }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'press relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-50',
        size === 'md' ? 'h-6 w-11' : 'h-8 w-14',
        checked ? 'border-transparent bg-accent' : 'border-line bg-surface-2',
      )}
    >
      <span
        className={clsx(
          'absolute left-0.5 rounded-full shadow-sm transition-transform duration-300 ease-spring',
          size === 'md' ? 'size-5' : 'size-7',
          checked ? 'bg-on-accent' : 'bg-muted',
          checked && (size === 'md' ? 'translate-x-5' : 'translate-x-6'),
        )}
      />
    </button>
  );
}
