import { IconMessage } from '../components/icons';
import { Badge, Card, Empty, ErrorBox, LoadingRows, Mono } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useApi } from '../lib/live';
import { href } from '../lib/router';
import type { BuyerMessage } from '../lib/types';

export function MessagesPage() {
  const { data, error, loading } = useApi<BuyerMessage[]>('/messages');
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows rows={6} />;
  const shipped = data.filter((m) => m.kind === 'shipped').length;
  const delivered = data.length - shipped;
  return (
    <div className="fade-in p-6">
      <Card
        title="Buyer message log"
        subtitle="One shipped and one delivered message per order, enforced by a unique key on (order, stage). Messages are logged, not sent anywhere."
        action={
          <div className="flex gap-1.5">
            <Badge tone="indigo">{shipped} shipped</Badge>
            <Badge tone="emerald">{delivered} delivered</Badge>
          </div>
        }
      >
        {data.length === 0 ? (
          <Empty icon={<IconMessage />} title="No buyer messages yet">
            A shipped message goes out when a tracking upload lands; a delivered one when the simulated carrier scan says delivered.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((m) => (
              <li key={m.id} className="flex items-start gap-4 px-4 py-3">
                <Badge tone={m.kind === 'delivered' ? 'emerald' : 'indigo'} className="mt-0.5 w-[72px] justify-center">
                  {m.kind}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-slate-800">{m.body}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    <a href={href('orders', m.orderId)} className="hover:text-slate-700">
                      <Mono>{m.orderId}</Mono>
                    </a>{' '}
                    · to {m.buyerName} · {fmtDateTime(m.sentAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
