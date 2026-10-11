import { useEffect, useState } from 'react';

export type Route = { page: string; id: string | null };

export function parseHash(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, '').split('/');
  return { page: page || 'overview', id: id ? decodeURIComponent(id) : null };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function href(page: string, id?: string | number | null): string {
  return id === undefined || id === null ? `#/${page}` : `#/${page}/${encodeURIComponent(String(id))}`;
}

export function go(page: string, id?: string | number | null): void {
  window.location.hash = href(page, id);
}
