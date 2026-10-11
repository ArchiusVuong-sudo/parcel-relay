import { IconUsers } from '../components/icons';
import { Badge, Button, Card, Empty, ErrorBox, LoadingRows, Mono, ScoreBars, ScorePill } from '../components/ui';
import { FIELD_LABEL, fmtDateTime } from '../lib/format';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { href } from '../lib/router';
import type { ReviewItem } from '../lib/types';
import { useAction } from '../lib/useAction';

const REASON: Record<ReviewItem['reason'], string> = {
  tie: 'Two open orders score within 0.10 of each other, so the matcher will not pick one.',
  low_score: 'The best order scores under 0.85.',
  no_match: 'No open order scores high enough.',
};

function ReviewCard({ item }: { item: ReviewItem }) {
  const assign = useAction(
    (orderId: string) => api.post(`/review/${item.shipmentId}/assign`, { orderId }),
    (orderId) => `Tracking ${item.trackingNumber} assigned to ${orderId}; upload queued`,
  );
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Mono>{item.trackingNumber}</Mono>
          <span className="font-normal text-slate-500">{item.carrier}</span>
        </span>
      }
      subtitle={`${item.supplierName} · ${item.subject} · ${fmtDateTime(item.receivedAt)}`}
      action={<Badge tone="amber">needs a person</Badge>}
    >
      <div className="space-y-4 p-4">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{REASON[item.reason]}</p>
        <div className="grid grid-cols-6 gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
          {(['buyer_name', 'street', 'postal_code', 'items'] as const).map((f) => (
            <div key={f} className={f === 'items' || f === 'street' ? 'col-span-2' : ''}>
              <div className="text-[11px] uppercase tracking-wide text-slate-400">{FIELD_LABEL[f]} (email)</div>
              <div className="text-[13px] font-medium text-slate-900">{item.fields[f]}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {item.candidates.slice(0, 2).map((c) => (
            <div key={c.orderId} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <a href={href('orders', c.orderId)} className="font-mono text-[13px] font-semibold text-slate-900 hover:text-indigo-700">
                  {c.orderId}
                </a>
                <ScorePill score={c.score} />
              </div>
              {c.order ? (
                <div className="mt-2 space-y-0.5 text-[13px] text-slate-700">
                  <div>{c.order.buyerName}</div>
                  <div className="text-slate-500">
                    {c.order.street}, {c.order.postalCode} {c.order.town}
                  </div>
                  <div className="font-medium text-slate-900">{c.order.items.map((i) => `${i.title} x${i.qty}`).join(', ')}</div>
                  <div className="text-xs text-slate-400">Placed {fmtDateTime(c.order.placedAt)}</div>
                </div>
              ) : null}
              <div className="my-3 border-t border-slate-100" />
              <ScoreBars breakdown={c.breakdown} compact />
              <Button variant="primary" className="mt-4 w-full" busy={assign.busy} onClick={() => assign.run(c.orderId)} disabled={c.order?.status !== 'awaiting_tracking'}>
                Assign to {c.orderId}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function ReviewPage() {
  const { data, error, loading } = useApi<ReviewItem[]>('/review');
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows rows={6} />;
  return (
    <div className="fade-in space-y-5 p-6">
      {data.length === 0 ? (
        <Card>
          <Empty icon={<IconUsers />} title="Nothing to review">
            Shipments land here when two open orders score too close to call, for example one buyer with two open orders.
          </Empty>
        </Card>
      ) : (
        data.map((item) => <ReviewCard key={item.shipmentId} item={item} />)
      )}
    </div>
  );
}
