import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { fmtClock } from '../lib/format';
import { useApi } from '../lib/live';
import { href } from '../lib/router';
import type { Meta, Overview } from '../lib/types';
import { useAction } from '../lib/useAction';
import { IconBox, IconClock, IconFactory, IconGauge, IconInbox, IconList, IconMessage, IconRefresh, IconRotate, IconUpload, IconUsers } from './icons';
import { Badge, Button, cx } from './ui';

const NAV = [
  { page: 'overview', label: 'Overview', icon: IconGauge },
  { page: 'inbox', label: 'Inbox', icon: IconInbox },
  { page: 'orders', label: 'Orders', icon: IconList },
  { page: 'uploads', label: 'Uploads', icon: IconUpload },
  { page: 'review', label: 'Review', icon: IconUsers },
  { page: 'suppliers', label: 'Suppliers', icon: IconFactory },
  { page: 'messages', label: 'Messages', icon: IconMessage },
] as const;

export const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  overview: { title: 'Overview', subtitle: 'Supplier emails in, checked tracking out' },
  inbox: { title: 'Inbox', subtitle: 'Shipping emails and what the parser found' },
  orders: { title: 'Orders', subtitle: 'Marketplace orders and their tracking state' },
  uploads: { title: 'Uploads', subtitle: 'Postgres job queue to the marketplace API' },
  review: { title: 'Review', subtitle: 'Shipments the matcher would not assign alone' },
  suppliers: { title: 'Suppliers', subtitle: 'Rule templates and drafts waiting for approval' },
  messages: { title: 'Messages', subtitle: 'Messages from the delivery monitor' },
};

function Sidebar({ page, meta }: { page: string; meta: Meta | undefined }) {
  const { data: ov } = useApi<Overview>('/overview');
  const counts: Record<string, number | undefined> = {
    inbox: ov?.tiles.emails_total,
    review: undefined,
    suppliers: undefined,
  };
  const needs = ov?.tiles.needs_person ?? 0;
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-2.5 border-b border-slate-100 px-5">
        <div className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-white shadow-sm">
          <IconBox size={18} />
        </div>
        <div>
          <div className="text-[15px] font-semibold tracking-tight text-slate-900">Parcel Relay</div>
          <div className="text-[11px] text-slate-500">Tracking pipeline prototype</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 p-3" aria-label="Main">
        {NAV.map(({ page: p, label, icon: Icon }) => {
          const active = page === p;
          const badge = p === 'review' && needs > 0 ? needs : counts[p];
          return (
            <a
              key={p}
              href={href(p)}
              className={cx(
                'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors',
                active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              <Icon className={active ? 'text-indigo-600' : 'text-slate-400'} />
              <span className="flex-1">{label}</span>
              {badge ? (
                <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', p === 'review' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500')}>{badge}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
      <div className="space-y-2 border-t border-slate-100 p-4 text-[11px] leading-relaxed text-slate-500">
        <div className="font-medium text-slate-700">{meta?.seller ?? 'Synthetic seller'}</div>
        <p>All orders, buyers, suppliers and carriers are invented. The marketplace and carrier scans are simulated.</p>
      </div>
    </aside>
  );
}

function Topbar({ page, meta }: { page: string; meta: Meta | undefined }) {
  const sync = useAction(
    () => api.post<{ batch: number; label: string }>('/sync'),
    () => `Synced batch ${meta?.inbox.nextBatch ?? ''}: ${meta?.inbox.nextLabel ?? ''}`,
  );
  const advance = useAction(() => api.post('/clock/advance'), 'Simulated clock moved 1 day; carrier scans replayed');
  const reset = useAction(() => api.post('/reset'), 'Demo reset to the seed');
  const mode = useAction((m: 'normal' | 'flaky') => api.put('/marketplace/mode', { mode: m }), (m) => `Simulated marketplace set to ${m}`);
  const t = PAGE_TITLES[page] ?? PAGE_TITLES.overview!;
  const inboxDone = meta ? meta.inbox.nextBatch > meta.inbox.totalBatches : false;

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-slate-200 bg-white/80 px-6 backdrop-blur">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-semibold tracking-tight text-slate-900">{t.title}</h1>
          <Badge tone="amber" title="Every record in this app is invented">Synthetic data</Badge>
          {meta?.llm.mode === 'replay' ? (
            <Badge tone="violet" title={meta.llm.reason}>Replay mode</Badge>
          ) : meta ? (
            <Badge tone="emerald" title={meta.llm.reason}>Live: {meta.llm.model}</Badge>
          ) : null}
        </div>
        <p className="truncate text-xs text-slate-500">{t.subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="mr-1 flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600" title="Simulated clock">
          <IconClock className="text-slate-400" size={14} />
          <span className="font-medium text-slate-700">Day {meta?.sim.day ?? 0}</span>
          <span className="tabular-nums">{meta ? fmtClock(meta.sim.now) : ''}</span>
        </div>
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs" role="group" aria-label="Simulated marketplace mode">
          <span className="px-2 text-slate-500">Marketplace</span>
          {(['normal', 'flaky'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => mode.run(m)}
              aria-pressed={meta?.marketplaceMode === m}
              className={cx(
                'h-7 rounded-md px-2.5 font-medium capitalize transition-colors',
                meta?.marketplaceMode === m ? (m === 'flaky' ? 'bg-white text-amber-700 shadow-sm' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500 hover:text-slate-800',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <Button variant="secondary" onClick={() => advance.run()} busy={advance.busy}>
          <IconClock size={14} /> Advance 1 day
        </Button>
        <Button variant="ghost" onClick={() => reset.run()} busy={reset.busy} title="Restore the seed: orders, queue, clock and marketplace mode">
          <IconRotate size={14} /> Reset demo
        </Button>
        <Button variant="primary" onClick={() => sync.run()} busy={sync.busy || meta?.inbox.processing} disabled={inboxDone} title={meta?.inbox.nextLabel ?? 'Mailbox empty'}>
          {sync.busy || meta?.inbox.processing ? null : <IconRefresh size={14} />}
          {inboxDone ? 'Inbox empty' : `Sync inbox`}
          {!inboxDone && meta ? (
            <span className="rounded bg-white/20 px-1 text-[11px] tabular-nums">
              {meta.inbox.nextBatch}/{meta.inbox.totalBatches}
            </span>
          ) : null}
        </Button>
      </div>
    </header>
  );
}

export function Layout({ page, children }: { page: string; children: ReactNode }) {
  const { data: meta } = useApi<Meta>('/meta');
  return (
    <div className="flex h-full">
      <Sidebar page={page} meta={meta} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar page={page} meta={meta} />
        <main className="scroll-thin min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
