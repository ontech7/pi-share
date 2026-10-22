import clsx from 'clsx';
import type { ReactNode } from 'react';

/** A setting with its explanation on the left and the control on the right; `stacked` puts wide controls below. */
export function SettingRow({
  label,
  hint,
  stacked,
  children,
}: {
  label: string;
  hint?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={clsx('flex gap-4 px-4 py-4 sm:px-5', stacked ? 'flex-col' : 'items-center justify-between')}>
      <div className="min-w-0">
        <p className="text-[15px] font-medium">{label}</p>
        {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
      </div>
      <div className={stacked ? '' : 'shrink-0'}>{children}</div>
    </div>
  );
}
