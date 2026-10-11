import { useState } from 'react';
import { useToast } from '../components/toast';
import { useLive } from './live';

/** Wraps a server action: busy flag, error toast, and a refetch when it settles. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, okText?: string | ((...args: A) => string)) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { bump } = useLive();
  const run = async (...args: A) => {
    setBusy(true);
    try {
      await fn(...args);
      if (okText) toast('ok', typeof okText === 'function' ? okText(...args) : okText);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
      bump();
    }
  };
  return { run, busy };
}
