import clsx from 'clsx';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { IconButton } from './Button.tsx';

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
};

/** Native <dialog>: focus trap, Escape and inert background come from the browser. */
export function Dialog({ open, onClose, title, closeLabel, children, footer, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only catches the backdrop, Escape is handled by <dialog>
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={clsx(
        'm-auto max-h-[min(90dvh,860px)] w-[calc(100%-1.5rem)] overflow-hidden rounded-3xl border border-line bg-surface p-0 text-fg shadow-card backdrop:bg-black/50 open:animate-pop',
        wide ? 'max-w-3xl' : 'max-w-md',
      )}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <IconButton label={closeLabel} icon={<X className="size-5" />} onClick={onClose} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
