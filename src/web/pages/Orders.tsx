import { useEffect } from 'react';
import { IconList, IconX } from '../components/icons';
import { Badge, Card, Empty, ErrorBox, KeyVal, LoadingRows, Mono, OrderStatusBadge, ScoreBars, ScorePill, cx } from '../components/ui';
import { CARRIER_NAME, fmtDateTime } from '../lib/format';
import { useApi } from '../lib/live';
import { go, href } from '../lib/router';
import type { OrderDetail, OrderListItem } from '../lib/types';

const EVENT_TONE: Record<string, string> = {
  matched: 'bg-emerald-500',
  assigned: 'bg-emerald-500',
  uploaded: 'bg-indigo-500',
  upload_queued: 'bg-sky-400',
  upload_retry: 'bg-amber-400',
  dead_letter: 'bg-rose-500',
  tracking_held: 'bg-rose-400',
  review_needed: 'bg-amber-400',
  review_resolved: 'bg-slate-400',
  tracking_found: 'bg-sky-500',
  in_transit: 'bg-violet-500',
  delivered: 'bg-emerald-600',
  buyer_message: 'bg-sky-300',
};

function Drawer({ id }: { id: string }) {
  const { data, error, loading } = useApi<OrderDetail>(`/orders/${id}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && go('orders');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close" className="flex-1 bg-slate-900/20" onClick={() => go('orders')} />
      <aside className="slide-in scroll-thin flex w-[560px] flex-col overflow-auto border-l border-slate-200 bg-slate-50 shadow-2xl" aria-label={`Order ${id}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Mono className="text-[15px] font-semibold text-slate-900">{id}</Mono>
            {data ? <OrderStatusBadge status={data.order.status} /> : null}
          </div>
          <button type="button" onClick={() => go('orders')} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close drawer">
            <IconX />
          </button>
        </div>
        {error ? <ErrorBox message={error} /> : null}
        {loading || !data ? (
          <LoadingRows rows={8} />
        ) : (
          <div className="space-y-4 p-5">
            <Card>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
                <KeyVal label="Buyer">{data.order.buyerName}</KeyVal>
                <KeyVal label="Ship to">
                  {data.order.street}, {data.order.postalCode} {data.order.town}
                </KeyVal>
                <KeyVal label="Items">{data.order.items.map((i) => `${i.title} x${i.qty}`).join(', ')}</KeyVal>
                <KeyVal label="Supplier">{data.order.supplierName}</KeyVal>
                <KeyVal label="Placed">{fmtDateTime(data.order.placedAt)}</KeyVal>
                <KeyVal label="Handling deadline">{fmtDateTime(data.order.deadline)}</KeyVal>
                <KeyVal label="Tracking">
                  {data.order.trackingNumber ? (
                    <span>
                      <Mono>{data.order.trackingNumber}</Mono> <span className="text-slate-500">{CARRIER_NAME[data.order.carrierCode ?? ''] ?? ''}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">none yet</span>
                  )}
                </KeyVal>
                <KeyVal label="On the marketplace (simulated)">
                  <span className={cx(data.marketplace.trackings > 1 && 'text-rose-700')}>
                    {data.marketplace.trackings} tracking{data.marketplace.trackings === 1 ? '' : 's'}
                  </span>
                </KeyVal>
              </dl>
            </Card>

            {data.match?.candidate ? (
              <Card
                title="Match score"
                subtitle={data.match.decidedBy === 'reviewer' ? 'Assigned by a person' : 'Matched automatically (score at least 0.85 and 0.10 ahead)'}
                action={<ScorePill score={data.match.candidate.score} />}
              >
                <div className="p-4">
                  <ScoreBars breakdown={data.match.candidate.breakdown} />
                  {data.match.candidates.length > 1 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
                      Other candidates:
                      {data.match.candidates
                        .filter((c) => c.orderId !== id)
                        .map((c) => (
                          <a key={c.orderId} href={href('orders', c.orderId)} className="inline-flex items-center gap-1 hover:text-slate-800">
                            <Mono>{c.orderId}</Mono> <ScorePill score={c.score} />
                          </a>
                        ))}
                    </div>
                  ) : null}
                  <a href={href('inbox', data.match.emailId)} className="mt-3 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-800">
                    Open the supplier email
                  </a>
                </div>
              </Card>
            ) : null}

            <Card title="Timeline" subtitle="Order events table, oldest first">
              {data.events.length === 0 ? (
                <Empty title="No events yet">Events appear when a supplier email mentions this order.</Empty>
              ) : (
                <ol className="relative px-5 py-4">
                  <span className="absolute bottom-6 left-[27px] top-6 w-px bg-slate-200" />
                  {data.events.map((ev) => (
                    <li key={ev.id} className="relative flex gap-3 pb-3 last:pb-0">
                      <span className={cx('relative mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-white', EVENT_TONE[ev.kind] ?? 'bg-slate-300')} />
                      <div>
                        <div className="text-[13px] text-slate-800">{ev.message}</div>
                        <div className="text-[11px] text-slate-400">{fmtDateTime(ev.at)}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            {data.messages.length ? (
              <Card title="Buyer messages">
                <ul className="divide-y divide-slate-100">
                  {data.messages.map((m) => (
                    <li key={m.id} className="px-4 py-2.5 text-[13px]">
                      <Badge tone={m.kind === 'delivered' ? 'emerald' : 'indigo'}>{m.kind}</Badge>
                      <p className="mt-1 text-slate-700">{m.body}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}

export function OrdersPage({ id }: { id: string | null }) {
  const { data, error, loading } = useApi<OrderListItem[]>('/orders');
  return (
    <div className="fade-in p-6">
      <Card>
        {error ? <ErrorBox message={error} /> : null}
        {loading ? <LoadingRows rows={10} /> : null}
        {data && data.length === 0 ? <Empty icon={<IconList />} title="No orders" /> : null}
        {data && data.length > 0 ? (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Buyer</th>
                <th className="px-4 py-2.5 font-medium">Items</th>
                <th className="px-4 py-2.5 font-medium">Supplier</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
                <th className="px-4 py-2.5 font-medium">Handling deadline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((o) => (
                <tr key={o.id} onClick={() => go('orders', o.id)} className={cx('cursor-pointer hover:bg-slate-50', id === o.id && 'bg-indigo-50/60')}>
                  <td className="px-4 py-2.5">
                    <Mono className="font-medium text-slate-900">{o.id}</Mono>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {o.buyerName}
                    <div className="text-[11px] text-slate-400">{o.town}</div>
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-2.5 text-slate-600">{o.items.map((i) => i.title).join(', ')}</td>
                  <td className="px-4 py-2.5 text-slate-600">{o.supplierName}</td>
                  <td className="px-4 py-2.5">
                    <OrderStatusBadge status={o.status} />
                  </td>
                  <td className="px-4 py-2.5">{o.trackingNumber ? <Mono className="text-slate-700">{o.trackingNumber}</Mono> : <span className="text-slate-300">-</span>}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    <span className={cx(o.overdue && 'font-medium text-rose-700')}>{fmtDateTime(o.deadline)}</span>
                    {o.overdue ? <Badge tone="rose" className="ml-2">late</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      {id ? <Drawer id={id} /> : null}
    </div>
  );
}
