import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { CRITERION_LABEL, ORDER_STATUS_LABEL, pct } from '../lib/format';
import type { Breakdown, EmailListItem, OrderStatus } from '../lib/types';
import { IconAlert } from './icons';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Tone = 'slate' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet';

const TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};

export function Badge({ tone = 'slate', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', TONES[tone], className)}>
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:bg-indigo-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 shadow-sm hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-white text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:text-rose-300',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-500 disabled:bg-emerald-300',
};

export function Button({ variant = 'secondary', busy, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx('inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed', VARIANTS[variant], className)}
    >
      {busy ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  );
}

export function Card({ children, className, title, action, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]', className)}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', className ?? 'size-4')} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? <div className="mb-3 grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500">{icon}</div> : null}
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {children ? <div className="mt-1 max-w-sm text-[13px] text-slate-500">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="m-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800">
      <IconAlert className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

const ORDER_TONE: Record<OrderStatus, Tone> = {
  awaiting_tracking: 'slate',
  uploading: 'sky',
  uploaded: 'indigo',
  in_transit: 'violet',
  delivered: 'emerald',
  cancelled: 'rose',
  upload_failed: 'rose',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={ORDER_TONE[status]}>{ORDER_STATUS_LABEL[status]}</Badge>;
}

/** The one-line state of an email, as the seller reads it. */
export function emailState(e: Pick<EmailListItem, 'status' | 'parseMethod' | 'reason' | 'shipmentStatus'>): { label: string; tone: Tone } {
  switch (e.status) {
    case 'held': {
      const m = /held: ([^.]+)/.exec(e.reason ?? '');
      return { label: `held: ${m?.[1] ?? 'check failed'}`, tone: 'rose' };
    }
    case 'duplicate':
      return { label: 'duplicate', tone: 'slate' };
    case 'drafting':
      return { label: 'drafting parser', tone: 'violet' };
    case 'waiting_approval':
      return { label: 'waiting for approval', tone: 'amber' };
    case 'failed':
      return { label: 'failed', tone: 'rose' };
    case 'received':
      return { label: 'queued', tone: 'slate' };
    case 'parsed':
      if (e.shipmentStatus === 'needs_review') return { label: 'needs review', tone: 'amber' };
      return { label: e.parseMethod === 'llm' ? 'parsed (approved draft)' : 'rule parsed', tone: 'emerald' };
  }
}

export function ScoreBars({ breakdown, compact }: { breakdown: Breakdown[]; compact?: boolean }) {
  return (
    <div className={cx('space-y-2', compact && 'space-y-1.5')}>
      {breakdown.map((b) => (
        <div key={b.criterion} className="grid grid-cols-[96px_1fr_64px] items-center gap-3 text-xs">
          <span className="text-slate-600">{CRITERION_LABEL[b.criterion]}</span>
          <div className="relative h-2 overflow-hidden rounded-full bg-slate-100" title={b.note}>
            <div className="absolute inset-y-0 left-0 rounded-full bg-slate-200" style={{ width: `${b.weight * 100 * (100 / 30)}%`, maxWidth: '100%' }} />
            <div className={cx('absolute inset-y-0 left-0 rounded-full', b.similarity >= 0.99 ? 'bg-emerald-500' : b.similarity > 0 ? 'bg-amber-400' : 'bg-rose-300')} style={{ width: `${b.points * 100 * (100 / 30)}%`, maxWidth: '100%' }} />
          </div>
          <span className="text-right font-mono tabular-nums text-slate-700">
            {b.points.toFixed(3)}
            <span className="text-slate-400">/{b.weight.toFixed(2)}</span>
          </span>
        </div>
      ))}
      {!compact ? <p className="pt-1 text-[11px] text-slate-400">Bar length is points out of the largest weight (0.30). Grey shows the weight of each criterion.</p> : null}
    </div>
  );
}

export function ScorePill({ score }: { score: number }) {
  const tone: Tone = score >= 0.85 ? 'emerald' : score >= 0.6 ? 'amber' : 'rose';
  return (
    <Badge tone={tone} className="font-mono tabular-nums" title={`Match score ${pct(score)}`}>
      {score.toFixed(3)}
    </Badge>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[12px] tabular-nums', className)}>{children}</span>;
}

export function KeyVal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-slate-800">{children}</dd>
    </div>
  );
}
