import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';

/** Bumps a version on every server event (SSE), so mounted views refetch. */
const LiveContext = createContext<{ version: number; bump: () => void; connected: boolean }>({ version: 0, bump: () => {}, connected: false });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const timer = useRef<number | null>(null);

  const bump = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setVersion((v) => v + 1);
    }, 120);
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => bump();
    return () => source.close();
  }, [bump]);

  return <LiveContext.Provider value={{ version, bump, connected }}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetches a path and refetches on every live event. Keeps the last data while refreshing. */
export function useApi<T>(path: string | null): Query<T> {
  const { version } = useLive();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef(path);

  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(undefined);
      setLoading(true);
    }
    if (path === null) return;
    let cancelled = false;
    api
      .get<T>(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, version, nonce]);

  return { data, error, loading: loading && data === undefined, reload: () => setNonce((n) => n + 1) };
}
