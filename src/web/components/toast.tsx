import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { IconAlert, IconCheck } from './icons';
import { cx } from './ui';

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-96 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'fade-in pointer-events-auto flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px] shadow-lg ring-1',
              t.kind === 'ok' ? 'bg-slate-900 text-white ring-slate-800' : 'bg-white text-rose-800 ring-rose-200',
            )}
          >
            {t.kind === 'ok' ? <IconCheck className="mt-0.5 shrink-0 text-emerald-400" /> : <IconAlert className="mt-0.5 shrink-0" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
