import { IconArrowRight, IconCheck, IconInbox, IconSparkle, IconX } from '../components/icons';
import { Badge, Card, Empty, ErrorBox, LoadingRows, Mono, ScorePill, Spinner, cx, emailState } from '../components/ui';
import { FIELD_COLOR, FIELD_LABEL, fmtDateTime } from '../lib/format';
import { useApi } from '../lib/live';
import { go, href } from '../lib/router';
import type { EmailDetail, EmailListItem, FieldName } from '../lib/types';

const FIELD_ORDER: FieldName[] = ['tracking_number', 'carrier', 'buyer_name', 'street', 'postal_code', 'items'];

function Highlighted({ body, spans }: { body: string; spans: EmailDetail['spans'] }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start).filter((s, i, arr) => i === 0 || s.start >= arr[i - 1]!.end);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start > pos) parts.push(body.slice(pos, s.start));
    parts.push(
      <mark key={`${s.field}-${s.start}`} title={FIELD_LABEL[s.field]} className={cx('rounded px-0.5 ring-1 ring-inset', FIELD_COLOR[s.field])}>
        {body.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  }
  parts.push(body.slice(pos));
  return <pre className="scroll-thin overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-slate-700">{parts}</pre>;
}

function EmailRow({ e, active }: { e: EmailListItem; active: boolean }) {
  const state = emailState(e);
  return (
    <button
      type="button"
      onClick={() => go('inbox', e.id)}
      className={cx('block w-full border-l-2 px-4 py-3 text-left transition-colors', active ? 'border-indigo-500 bg-indigo-50/60' : 'border-transparent hover:bg-slate-50')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium text-slate-900">{e.fromName}</span>
        <span className="shrink-0 text-[11px] text-slate-400">batch {e.batch}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-slate-600">{e.subject}</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge tone={state.tone}>
          {e.status === 'drafting' ? <Spinner className="size-2.5" /> : null}
          {state.label}
        </Badge>
        {e.trackingNumber ? <Mono className="truncate text-slate-500">{e.trackingNumber}</Mono> : null}
      </div>
    </button>
  );
}

function Detail({ id }: { id: number }) {
  const { data: e, error, loading } = useApi<EmailDetail>(`/emails/${id}`);
  if (error) return <ErrorBox message={error} />;
  if (loading || !e) return <LoadingRows rows={6} />;
  const state = emailState(e);
  const match = e.match;
  const top = match?.candidates[0];

  return (
    <div className="fade-in space-y-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-slate-900">{e.subject}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {e.fromName} &lt;{e.fromAddr}&gt; · received {fmtDateTime(e.receivedAt)} (simulated clock) · {e.contentType}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Badge tone={state.tone}>{state.label}</Badge>
          {e.parseMethod ? (
            <Badge tone={e.parseMethod === 'rule' ? 'emerald' : 'violet'}>{e.parseMethod === 'rule' ? `rule template v${e.template?.version ?? 1}` : 'Claude draft'}</Badge>
          ) : null}
          <Badge tone={e.llmCalls ? 'violet' : 'slate'}>
            {e.llmCalls} LLM call{e.llmCalls === 1 ? '' : 's'}
          </Badge>
        </div>
      </div>

      {e.reason ? (
        <div className={cx('rounded-lg px-3 py-2 text-[13px]', e.status === 'held' || e.status === 'failed' ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-700')}>{e.reason}</div>
      ) : null}

      <div className="grid grid-cols-[1fr_300px] gap-4">
        <Card title="Raw email" subtitle={`Stored by content hash: ${e.blobKey.split('/').at(-1)?.slice(0, 16)}...`}>
          <Highlighted body={e.body} spans={e.spans} />
        </Card>
        <div className="space-y-4">
          <Card title="Extracted fields">
            {e.fields ? (
              <dl className="divide-y divide-slate-100">
                {FIELD_ORDER.map((f) => (
                  <div key={f} className="flex items-center gap-2 px-4 py-2">
                    <span className={cx('size-2 shrink-0 rounded-full ring-1', FIELD_COLOR[f])} />
                    <dt className="w-24 shrink-0 text-xs text-slate-500">{FIELD_LABEL[f]}</dt>
                    <dd className="min-w-0 truncate text-[13px] text-slate-900" title={e.fields?.[f]}>
                      {e.fields?.[f] ?? <span className="text-slate-400">not found</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <Empty title={e.status === 'drafting' ? 'Drafting a parser...' : 'Not parsed'}>{e.status === 'waiting_approval' ? 'This supplier has no approved template yet.' : null}</Empty>
            )}
          </Card>

          {e.check ? (
            <Card title="Tracking check">
              <div className="space-y-2 px-4 py-3 text-[13px]">
                <div className="flex items-center gap-2">
                  {e.check.ok ? <IconCheck className="text-emerald-600" /> : <IconX className="text-rose-600" />}
                  <span className={e.check.ok ? 'text-emerald-800' : 'text-rose-800'}>{e.check.detail}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {e.check.carrierName} · <Mono>{e.trackingNumber}</Mono>
                </div>
              </div>
            </Card>
          ) : null}

          {match && top ? (
            <Card title="Order match">
              <div className="space-y-2 px-4 py-3 text-[13px]">
                {e.orderId ? (
                  <a href={href('orders', e.orderId)} className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 hover:bg-emerald-100">
                    <span>
                      Matched to <Mono className="font-semibold">{e.orderId}</Mono>
                    </span>
                    <IconArrowRight />
                  </a>
                ) : e.status === 'held' ? (
                  <p className="text-slate-600">
                    Held, so not queued. Likely order <Mono>{top.orderId}</Mono>.
                  </p>
                ) : e.shipmentStatus === 'needs_review' ? (
                  <a href={href('review')} className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-amber-800 hover:bg-amber-100">
                    <span>Waiting for a person in Review</span>
                    <IconArrowRight />
                  </a>
                ) : (
                  <p className="text-slate-600">
                    Likely order <Mono>{top.orderId}</Mono>, no upload until the template is approved.
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 text-xs text-slate-500">
                  {match.candidates.slice(0, 3).map((c) => (
                    <span key={c.orderId} className="inline-flex items-center gap-1">
                      <Mono>{c.orderId}</Mono> <ScorePill score={c.score} />
                    </span>
                  ))}
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function InboxPage({ id }: { id: string | null }) {
  const { data, error, loading } = useApi<EmailListItem[]>('/emails');
  const selected = id ? Number(id) : data?.[0]?.id;
  return (
    <div className="grid h-full grid-cols-[360px_1fr]">
      <div className="scroll-thin overflow-auto border-r border-slate-200 bg-white">
        {error ? <ErrorBox message={error} /> : null}
        {loading ? <LoadingRows rows={6} /> : null}
        {data && data.length === 0 ? (
          <Empty icon={<IconInbox />} title="The inbox is empty">
            Click <b>Sync inbox</b> to pull batch 1: four shipping emails from known suppliers.
          </Empty>
        ) : null}
        <div className="divide-y divide-slate-100">{data?.map((e) => <EmailRow key={e.id} e={e} active={e.id === selected} />)}</div>
      </div>
      <div className="scroll-thin min-w-0 overflow-auto">
        {selected ? (
          <Detail id={selected} />
        ) : (
          <Empty icon={<IconSparkle />} title="Pick an email">
            The parsed fields, the check-digit result and the order match show here.
          </Empty>
        )}
      </div>
    </div>
  );
}
