import { IconCheck, IconFactory, IconSparkle, IconX } from '../components/icons';
import { Badge, Button, Card, Empty, ErrorBox, LoadingRows, Mono, Spinner, cx } from '../components/ui';
import { api } from '../lib/api';
import { FIELD_LABEL, fmtDateTime, fmtMs, fmtUsd } from '../lib/format';
import { useApi } from '../lib/live';
import type { FieldName, LlmRun, SupplierView, TemplateView } from '../lib/types';
import { useAction } from '../lib/useAction';

const FIELDS: FieldName[] = ['tracking_number', 'carrier', 'buyer_name', 'street', 'postal_code', 'items'];

function RunStats({ run }: { run: LlmRun }) {
  const replay = run.mode === 'replay';
  return (
    <div className="grid grid-cols-5 gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 text-[13px]">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Run</div>
        {replay ? <Badge tone="violet">Recorded run (replay)</Badge> : <Badge tone="emerald">Live call</Badge>}
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Model</div>
        <Mono>{run.model}</Mono>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Latency{replay ? ' (recorded)' : ''}</div>
        <span className="tabular-nums">{fmtMs(run.duration_ms)}</span>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Cost estimate{replay ? ' (recorded)' : ''}</div>
        <span className="tabular-nums">{fmtUsd(run.cost_usd)}</span>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Turns / tries</div>
        <span className="tabular-nums">
          {run.num_turns ?? '-'} / {run.attempts}
        </span>
      </div>
      {replay && run.recorded_at ? <div className="col-span-5 text-[11px] text-slate-500">Recorded from a live run on {fmtDateTime(run.recorded_at)}. Replay took {fmtMs(run.output?.replayMs ?? 0)}.</div> : null}
      {run.output?.fallbackReason ? <div className="col-span-5 text-[11px] text-amber-700">Live call failed ({run.output.fallbackReason}), so the recorded run was used.</div> : null}
    </div>
  );
}

function Draft({ supplier, template, run }: { supplier: SupplierView; template: TemplateView; run: LlmRun | undefined }) {
  const approve = useAction(() => api.post(`/suppliers/${supplier.id}/approve`), `Template approved: ${supplier.name} is now parsed by rule`);
  const reject = useAction(() => api.post(`/suppliers/${supplier.id}/reject`), 'Draft rejected; nothing was uploaded');
  const test = template.test_result;
  const confidence = run?.output?.confidence;

  return (
    <div className="space-y-4 p-4">
      {run ? <RunStats run={run} /> : null}
      <div className="grid grid-cols-[1.1fr_1fr] gap-4">
        <div className="rounded-xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-[13px] font-semibold text-slate-900">Draft template v{template.version}</span>
            <span className="text-xs text-slate-500">
              flags <Mono>{template.spec.flags || 'none'}</Mono>
            </span>
          </div>
          <table className="w-full text-[12px]">
            <tbody className="divide-y divide-slate-100">
              {FIELDS.map((f) => {
                const ft = test?.fields.find((x) => x.field === f);
                return (
                  <tr key={f} className="align-top">
                    <td className="w-28 px-4 py-2 text-slate-500">{FIELD_LABEL[f]}</td>
                    <td className="px-2 py-2">
                      <code className="break-all font-mono text-[11.5px] text-slate-800">{template.spec.patterns[f]}</code>
                      {ft && ft.issues.length ? <div className="mt-1 text-[11px] text-rose-700">{ft.issues.map((i) => i.message).join('; ')}</div> : null}
                    </td>
                    <td className="w-8 px-3 py-2">{ft?.pass ? <IconCheck className="text-emerald-600" /> : <IconX className="text-rose-600" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-slate-900">Fields Claude read</span>
              {confidence !== undefined ? <Badge tone={confidence >= 0.8 ? 'emerald' : 'amber'}>confidence {confidence.toFixed(2)}</Badge> : null}
            </div>
            <dl className="divide-y divide-slate-100 text-[13px]">
              {FIELDS.map((f) => (
                <div key={f} className="flex gap-2 px-4 py-1.5">
                  <dt className="w-24 shrink-0 text-xs text-slate-500">{FIELD_LABEL[f]}</dt>
                  <dd className="min-w-0 truncate text-slate-900">{run?.output?.fields[f]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className={cx('rounded-xl px-4 py-3 text-[13px]', test?.passed ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900')}>
            <div className="flex items-center gap-2 font-semibold">
              {test?.passed ? <IconCheck /> : <IconX />} Template test {test?.passed ? 'passed' : 'failed'}
            </div>
            <p className="mt-1 text-xs opacity-80">{test?.summary}. The app ran it again itself, through the guard: length cap, one capture group, no backreferences, no nested quantifiers, no values copied from the email, 50 ms vm timeout.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
        <p className="text-[13px] text-indigo-900">Nothing from this supplier uploads until a person approves. After approval, its emails are parsed by this template with no LLM call.</p>
        <div className="flex shrink-0 gap-2">
          <Button variant="danger" onClick={() => reject.run()} busy={reject.busy}>
            Reject
          </Button>
          <Button variant="success" onClick={() => approve.run()} busy={approve.busy} disabled={!test?.passed}>
            <IconCheck size={14} /> Approve template
          </Button>
        </div>
      </div>
      {run?.trace.length ? (
        <div className="rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-900">Trace</div>
          <ol className="divide-y divide-slate-100 text-[12.5px]">
            {run.trace.map((t, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-1.5">
                <span className="w-14 text-right font-mono text-[11px] tabular-nums text-slate-400">{fmtMs(t.atMs)}</span>
                <Badge tone={t.kind === 'tool_result' ? (t.label.includes('passed') ? 'emerald' : 'amber') : t.kind === 'schema_check' ? 'sky' : t.kind === 'fallback' ? 'violet' : 'slate'}>{t.kind.replace('_', ' ')}</Badge>
                <span className="text-slate-700">{t.label}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

    </div>
  );
}

function SupplierCard({ s }: { s: SupplierView }) {
  const approved = s.templates.find((t) => t.status === 'approved');
  const draft = [...s.templates].reverse().find((t) => t.status === 'draft');
  const lastRun = s.runs.at(-1);
  const draftRun = draft ? s.runs.find((r) => r.id === draft.llm_run_id) : undefined;
  const redraft = useAction(() => api.post(`/suppliers/${s.id}/redraft`), 'Drafting again');
  const drafting = s.status !== 'active' && !draft && lastRun === undefined;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {s.name}
          {s.status === 'active' ? <Badge tone="emerald">active</Badge> : s.status === 'rejected' ? <Badge tone="rose">draft rejected</Badge> : <Badge tone="amber">new supplier</Badge>}
          {approved ? <Badge tone={approved.source === 'seed' ? 'slate' : 'violet'}>{approved.source === 'seed' ? 'seeded template' : 'drafted by Claude, approved'}</Badge> : null}
        </span>
      }
      subtitle={
        <>
          <Mono>{s.sender_domain}</Mono> · layout: {s.layout ?? 'unknown'} · {s.stats.emails} email{s.stats.emails === 1 ? '' : 's'}, {s.stats.rule} parsed by rule, {s.stats.llm_calls} LLM call
          {s.stats.llm_calls === 1 ? '' : 's'}
        </>
      }
      action={
        s.status !== 'active' && !draft && lastRun ? (
          <Button onClick={() => redraft.run()} busy={redraft.busy}>
            <IconSparkle size={14} /> Draft again
          </Button>
        ) : null
      }
    >
      {draft ? <Draft supplier={s} template={draft} run={draftRun} /> : null}
      {drafting ? (
        <div className="flex items-center gap-3 px-4 py-5 text-[13px] text-violet-800">
          <Spinner className="size-4 text-violet-600" /> Claude is reading the email and drafting a template. Its parse waits for approval.
        </div>
      ) : null}
      {s.status !== 'active' && !draft && lastRun && !lastRun.ok ? <div className="px-4 py-3 text-[13px] text-rose-700">Last draft failed: {lastRun.error}</div> : null}
      {approved && !draft ? (
        <div className="grid grid-cols-3 gap-x-6 gap-y-1.5 px-4 py-3 text-[12px]">
          {FIELDS.map((f) => (
            <div key={f} className="min-w-0">
              <span className="text-slate-400">{FIELD_LABEL[f]}: </span>
              <code className="break-all font-mono text-[11px] text-slate-700">{approved.spec.patterns[f]}</code>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function SuppliersPage() {
  const { data, error, loading } = useApi<SupplierView[]>('/suppliers');
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows rows={6} />;
  const pending = data.filter((s) => s.status !== 'active');
  const active = data.filter((s) => s.status === 'active');
  return (
    <div className="fade-in space-y-5 p-6">
      {pending.map((s) => (
        <SupplierCard key={s.id} s={s} />
      ))}
      {active.length === 0 ? <Empty icon={<IconFactory />} title="No suppliers" /> : active.map((s) => <SupplierCard key={s.id} s={s} />)}
    </div>
  );
}
