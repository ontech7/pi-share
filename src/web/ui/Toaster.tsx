import clsx from 'clsx';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react';

type Toast = { id: number; text: string; tone: 'ok' | 'error' };
type Notify = (text: string, tone?: Toast['tone']) => void;

const ToastContext = createContext<Notify>(() => {});

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback<Notify>((text, tone = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'animate-enter flex items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm font-medium shadow-card',
              toast.tone === 'error' && 'text-danger',
            )}
          >
            {toast.tone === 'ok' ? <CircleCheck className="size-4 text-ok" /> : <CircleAlert className="size-4" />}
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export const useToast = () => use(ToastContext);
