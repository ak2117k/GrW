import { CreditCard, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { usePayments, groupByMonth, type PaymentRow } from '@/hooks/usePayments';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtAmount = (paise: number) => inr.format(paise / 100);
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};
const STATUS_TONE: Record<string, string> = {
  CAPTURED: 'bg-emerald-500/15 text-emerald-300',
  FAILED: 'bg-red-500/15 text-red-300',
  REFUNDED: 'bg-amber-500/15 text-amber-300',
};

function Row({ p }: { p: PaymentRow }) {
  return (
    <TiltCard maxTiltDeg={4}>
      <div className="depth-card depth-rise flex items-center justify-between rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">{p.description ?? p.segment ?? 'Payment'}</span>
          <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
            {new Date(p.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_TONE[p.status] ?? 'bg-gray-500/15 text-gray-300')}>{p.status}</span>
          <span className="text-sm font-semibold tabular-nums text-[var(--color-text-primary)]">{fmtAmount(p.amount)}</span>
          {p.invoiceUrl && (
            <a href={p.invoiceUrl} target="_blank" rel="noreferrer" className="text-[var(--color-accent-blue)] hover:opacity-80"><ExternalLink size={15} /></a>
          )}
        </div>
      </div>
    </TiltCard>
  );
}

export default function PaymentsPage() {
  const { payments, loading, error } = usePayments();
  const groups = groupByMonth(payments);

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-center gap-3">
        <CreditCard size={24} className="text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Payments</h1>
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">{error}</div>}
      {!loading && !error && payments.length === 0 && (
        <div className="glass-panel p-8 text-center text-[var(--color-text-muted)]">
          No payments yet. Your subscription charges will appear here.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.month} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{monthLabel(g.month)}</h2>
          {g.rows.map((p) => <Row key={p.id} p={p} />)}
        </div>
      ))}
    </div>
  );
}
