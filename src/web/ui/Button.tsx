import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner.tsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent hover:brightness-105 shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_6px_20px_-8px_var(--accent)]',
  secondary: 'bg-surface-2 text-fg hover:bg-line/70 border border-line',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'text-danger hover:bg-danger/10 border border-danger/30',
};

type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
  icon: 'size-10',
  'icon-sm': 'size-8',
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'press inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium transition-[background-color,color,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

type IconButtonProps = Omit<Props, 'children' | 'size'> & { label: string; small?: boolean };

export function IconButton({ label, small, ...rest }: IconButtonProps) {
  return <Button variant="ghost" aria-label={label} title={label} {...rest} size={small ? 'icon-sm' : 'icon'} />;
}
