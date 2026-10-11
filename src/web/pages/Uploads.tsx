import { IconUpload } from '../components/icons';
import { Badge, Card, Empty, ErrorBox, LoadingRows, Mono, cx } from '../components/ui';
import { fmtMs, fmtTime } from '../lib/format';
import { useApi } from '../lib/live';
import { href } from '../lib/router';
import type { JobView, Uploads } from '../lib/types';

function Attempt({ h }: { h: JobView['history'][number] }) {
  const label = h.outcome === 'ok' ? `${h.httpStatus ?? 200} ok` : h.code === 'TIMEOUT' ? 'timeout' : `${h.httpStatus ?? ''} ${h.code ?? ''}`.trim();
  const tone = h.outcome === 'ok' ? 'emerald' : h.outcome === 'retry' ? 'amber' : 'rose';
  const wait = h.nextRunAt ? ` · retry in ${fmtMs(new Date(h.nextRunAt).getTime() - new Date(h.startedAt).getTime() - h.durationMs)}` : '';
  return (
    <Badge tone={tone} title={`${h.message ?? ''} (${fmtMs(h.durationMs)})`}>
      #{h.attempt} {label}
      {wait}
    </Badge>
  );
}

function JobTable({ jobs }: { jobs: JobView[] }) {
  return (
    <table className="w-full text-left text-[13px]">
      <thead>
        <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
          <th className="px-4 py-2.5 font-medium">Job</th>
          <th className="px-4 py-2.5 font-medium">Order</th>
          <th className="px-4 py-2.5 font-medium">Status</th>
          <th className="px-4 py-2.5 font-medium">Attempts</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {jobs.map((j) => (
          <tr key={j.id} className="align-top">
            <td className="px-4 py-2.5">
              <Mono className="text-slate-500">#{j.id}</Mono>
            </td>
            <td className="px-4 py-2.5">
              {j.orderId ? (
                <a href={href('orders', j.orderId)} className="font-mono text-[12px] font-medium text-indigo-700 hover:text-indigo-900">
                  {j.orderId}
                </a>
              ) : null}
              <div className="mt-0.5 max-w-[260px] truncate font-mono text-[10px] text-slate-400" title={`Idempotency key: ${j.idempotencyKey}`}>
                {j.idempotencyKey}
              </div>
            </td>
            <td className="px-4 py-2.5">
              <Badge tone={j.status === 'done' ? 'emerald' : j.status === 'dead' ? 'rose' : j.status === 'running' ? 'sky' : 'slate'}>
                {j.status === 'queued' && j.attempts > 0 ? 'backing off' : j.status === 'dead' ? 'dead letter' : j.status}
              </Badge>
            </td>
            <td className="px-4 py-2.5">
              <div className="flex flex-wrap gap-1">
                {j.history.length ? j.history.map((h) => <Attempt key={h.attempt} h={h} />) : <span className="text-xs text-slate-400">waiting</span>}
              </div>
              {j.status === 'dead' && j.lastError ? <div className="mt-1 text-xs text-rose-700">{j.lastError}</div> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UploadsPage() {
  const { data, error, loading } = useApi<Uploads>('/uploads');
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows rows={8} />;
  const live = data.jobs.filter((j) => j.status !== 'dead');
  const dead = data.jobs.filter((j) => j.status === 'dead');
  const retried = data.jobs.filter((j) => j.history.some((h) => h.outcome === 'retry')).length;

  return (
    <div className="fade-in grid grid-cols-[1fr_400px] gap-5 p-6">
      <div className="space-y-5">
        <Card
          title="Upload jobs"
          subtitle="Claimed with FOR UPDATE SKIP LOCKED; retries back off exponentially with jitter; one idempotency key per order and tracking"
          action={retried ? <Badge tone="amber">{retried} retried</Badge> : null}
        >
          {live.length === 0 ? (
            <Empty icon={<IconUpload />} title="No uploads yet">
              Matched shipments queue an upload here. Switch the marketplace to <b>Flaky</b> to see 429s and timeouts retried.
            </Empty>
          ) : (
            <JobTable jobs={live} />
          )}
        </Card>
        <Card title="Dead letter" subtitle="Permanent errors stop at once; transient ones stop after 5 attempts">
          {dead.length === 0 ? <Empty title="Nothing in dead letter" /> : <JobTable jobs={dead} />}
        </Card>
      </div>

      <div className="space-y-5">
        <Card title="Simulated marketplace" subtitle="What the marketplace holds per order. One tracking each, whatever the retries.">
          {data.marketplace.orders.length === 0 ? (
            <Empty title="No requests yet" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.marketplace.orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <Mono className="font-medium text-slate-900">{o.id}</Mono>
                    <div className="truncate font-mono text-[11px] text-slate-400">{o.trackingNumber ?? (o.status === 'cancelled' ? 'order cancelled by buyer' : 'no tracking')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">
                      {o.requests} request{o.requests === 1 ? '' : 's'}
                    </span>
                    <Badge tone={o.trackings === 1 ? 'emerald' : o.status === 'cancelled' ? 'rose' : 'slate'}>
                      {o.status === 'cancelled' ? 'cancelled' : `${o.trackings} tracking`}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Request log" subtitle="Newest first">
          {data.marketplace.requests.length === 0 ? (
            <Empty title="No requests yet" />
          ) : (
            <ul className="scroll-thin max-h-[340px] divide-y divide-slate-100 overflow-auto font-mono text-[12px]">
              {data.marketplace.requests.map((r) => (
                <li key={r.seq} className="flex items-center gap-3 px-4 py-1.5">
                  <span className="w-7 text-slate-400">{r.seq}</span>
                  <span className="text-slate-700">{r.orderId}</span>
                  <span className={cx('font-semibold', r.statusCode < 300 ? 'text-emerald-700' : r.statusCode === 429 ? 'text-amber-700' : 'text-rose-700')}>{r.statusCode}</span>
                  <span className="flex-1 truncate text-slate-500">{r.outcome.replaceAll('_', ' ')}</span>
                  <span className="text-slate-400">{fmtTime(r.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
