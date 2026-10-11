import { IconAlert, IconArrowRight, IconInbox, IconShield, IconSparkle } from '../components/icons';
import { Badge, Card, Empty, ErrorBox, LoadingRows, Mono, cx } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useApi } from '../lib/live';
import { href } from '../lib/router';
import type { Overview as OverviewData, Tiles } from '../lib/types';

const FLOW: { key: keyof Tiles; label: string; tone: string }[] = [
  { key: 'awaiting_tracking', label: 'Awaiting tracking', tone: 'text-slate-900' },
  { key: 'uploading', label: 'Uploading', tone: 'text-sky-700' },
  { key: 'uploaded', label: 'Uploaded', tone: 'text-indigo-700' },
  { key: 'in_transit', label: 'In transit', tone: 'text-violet-700' },
  { key: 'delivered', label: 'Delivered', tone: 'text-emerald-700' },
];

const EVENT_DOT: Record<string, string> = {
  matched: 'bg-emerald-500',
  assigned: 'bg-emerald-500',
  uploaded: 'bg-indigo-500',
  upload_retry: 'bg-amber-400',
  dead_letter: 'bg-rose-500',
  tracking_held: 'bg-rose-400',
  review_needed: 'bg-amber-400',
  delivered: 'bg-emerald-600',
  in_transit: 'bg-violet-500',
  buyer_message: 'bg-sky-400',
};

function Stat({ label, value, hint, tone, to }: { label: string; value: number; hint?: string; tone?: string; to?: string }) {
  const body = (
    <>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums tracking-tight', tone ?? 'text-slate-900')}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </>
  );
  return to ? (
    <a href={to} className="block rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-slate-300">
      {body}
    </a>
  ) : (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">{body}</div>
  );
}

export function OverviewPage() {
  const { data, error, loading } = useApi<OverviewData>('/overview');
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows rows={8} />;
  const t = data.tiles;

  return (
    <div className="fade-in space-y-5 p-6">
      <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-[13px] text-amber-900">
        <IconShield className="shrink-0 text-amber-600" />
        <span>
          <b className="font-semibold">Synthetic data.</b> Every order, buyer, supplier and carrier here is invented. The marketplace API and carrier scans are simulated.
        </span>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Order flow</div>
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2">
          {FLOW.map((f, i) => (
            <div key={f.key} className="contents">
              <Stat label={f.label} value={t[f.key]} tone={f.tone} to={href('orders')} />
              {i < FLOW.length - 1 ? <IconArrowRight className="text-slate-300" /> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Held before upload" value={t.held} hint="bad check digit or carrier not accepted" tone={t.held ? 'text-rose-700' : undefined} to={href('inbox')} />
        <Stat label="Waiting for a person" value={t.needs_person} hint="review ties and template approvals" tone={t.needs_person ? 'text-amber-700' : undefined} to={href('review')} />
        <Stat label="Dead letter" value={t.dead_letter} hint="permanent marketplace errors" tone={t.dead_letter ? 'text-rose-700' : undefined} to={href('uploads')} />
        <Stat label="Emails parsed by rule" value={t.rule_parsed} hint={`of ${t.emails_total} emails, ${t.llm_calls} LLM call${t.llm_calls === 1 ? '' : 's'} in total`} to={href('suppliers')} />
      </div>

      <div className="grid grid-cols-[1fr_1.15fr] gap-5">
        <Card title="Late-risk orders" subtitle="No tracking yet and past, or within 12 h of, the handling deadline" action={data.lateRisk.length ? <Badge tone="rose">{data.lateRisk.length}</Badge> : null}>
          {data.lateRisk.length === 0 ? (
            <Empty icon={<IconAlert />} title="No order is close to its deadline">
              Orders show here when they have no tracking 12 hours before the handling deadline.
            </Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.lateRisk.map((r) => (
                <li key={r.orderId}>
                  <a href={href('orders', r.orderId)} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                    <span className={cx('size-2 shrink-0 rounded-full', r.state === 'overdue' ? 'bg-rose-500' : 'bg-amber-400')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px]">
                        <Mono className="font-medium text-slate-900">{r.orderId}</Mono>
                        <span className="truncate text-slate-600">{r.buyerName}</span>
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {r.supplierName} · deadline {fmtDateTime(r.deadline)}
                        {r.note ? ` · ${r.note.split('.')[0]}` : ''}
                      </div>
                    </div>
                    {r.state === 'overdue' ? <Badge tone="rose">{r.hoursOverdue} h overdue</Badge> : <Badge tone="amber">{r.hoursLeft} h left</Badge>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent activity" subtitle="Latest entries from the order timelines">
          {data.activity.length === 0 ? (
            <Empty icon={<IconInbox />} title="Nothing has happened yet">
              Click <b>Sync inbox</b> to pull the first batch of supplier emails.
            </Empty>
          ) : (
            <ul className="scroll-thin max-h-[380px] divide-y divide-slate-100 overflow-auto">
              {data.activity.map((a) => (
                <li key={a.id}>
                  <a href={href('orders', a.orderId)} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', EVENT_DOT[a.kind] ?? 'bg-slate-300')} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-slate-800">{a.message}</div>
                      <div className="text-[11px] text-slate-400">
                        <Mono>{a.orderId}</Mono> · {a.buyerName} · {fmtDateTime(a.at)}
                      </div>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <IconSparkle size={12} /> Tiles read from a Postgres view over orders, emails, shipments and jobs. They update live over server-sent events.
      </p>
    </div>
  );
}
