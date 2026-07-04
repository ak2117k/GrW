import { useState } from 'react';
import clsx from 'clsx';
import { useIntradayEntries } from '../../hooks/useIntradayEntries';
import { summarizeOpenBook } from '../../utils/swingOpenBook';
import { SignalCard, SignalSummaryStrip } from '@/components/signals';
import { useAuthStore } from '../../stores/auth-store';
import { useSubscriptions, shouldShowSubscribeCard } from '../../hooks/useSubscriptions';
import { SubscribeCard } from '../../components/product/SubscribeCard';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Expired', value: 'EXPIRED' },
] as const;

const NOTIONAL = 200_000; // ₹2L fixed notional per trade

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export default function IntradayPage() {
  // NOTE: all hooks are called unconditionally before any early return, so the
  // hook order is stable regardless of role/subscription branching below.
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [date, setDate] = useState(todayIST());
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'ADMIN';
  const subs = useSubscriptions();
  // Only fetch the plan-gated data once access is known — otherwise an
  // unsubscribed USER fires a 403 that would flash before the gate resolves.
  const canView = isAdmin || subs.intraday;
  const { entries, pnl, loading, error } = useIntradayEntries(filter, date, canView);
  // Open (unrealized) book: floating mark-to-market P&L of positions not yet
  // closed (exitPrice null). Kept separate from the realized period cards so
  // booked vs floating P&L are never conflated.
  const openEntries = entries.filter((e) => e.exitPrice == null);
  const { openCount, invested, currentValue, unrealizedRs } = summarizeOpenBook(openEntries, NOTIONAL);

  // While the subscription status is still resolving, show a quiet loading
  // state — NOT the table (which would surface the gated data call's 403).
  if (!isAdmin && subs.loading) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
        </div>
        <div className="text-[var(--color-text-muted)]">Loading…</div>
      </div>
    );
  }

  // Gate: an unsubscribed USER (non-admin) sees the Subscribe placeholder
  // instead of the signals table. Branch happens AFTER all hooks above.
  if (shouldShowSubscribeCard(isAdmin, subs.loading, subs.intraday)) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
        </div>
        <SubscribeCard segment="Intraday" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
        </div>
        {openCount > 0 && (
          <span className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums glass-panel', unrealizedRs > 0 ? 'text-emerald-400' : unrealizedRs < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]')}>
            {unrealizedRs >= 0 ? '+' : '−'}₹{Math.abs(Math.round(unrealizedRs)).toLocaleString('en-IN')} unrealized
          </span>
        )}
      </div>

      <SignalSummaryStrip pnl={pnl ?? undefined} openCount={openCount} invested={invested} currentValue={currentValue} unrealizedRs={unrealizedRs} />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.label} onClick={() => setFilter(f.value)}
            className={clsx('rounded-full px-3 py-1 text-sm transition-colors',
              filter === f.value ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)]' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
            {f.label}
          </button>
        ))}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="ml-auto rounded-lg bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text-secondary)]" />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        entries.length === 0 ? (
          <div className="glass-panel p-8 text-center text-[var(--color-text-muted)]">No entries for this day yet.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e) => <SignalCard key={e.id} entry={e} isAdmin={isAdmin} notional={NOTIONAL} />)}
          </div>
        )
      )}
    </div>
  );
}
