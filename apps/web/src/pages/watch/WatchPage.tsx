import { useState } from 'react';
import { useWatchEntries } from '../../hooks/useWatchEntries';
import { WatchTable } from './WatchTable';
import { PaperAccountBadge } from '../../components/trading/PaperAccountBadge';
import { ComparisonStrip } from '../../components/trading/ComparisonStrip';
import { pnlBreakdown, accountRealPnl, dayRealizedSummary } from '../../utils/watchPnl';
import { usePaperAccount } from '../../hooks/usePaperAccount';
import { useDailyComparison } from '../../hooks/useDailyComparison';
import type { WatchStatus } from '../../types/watch.types';

const FILTERS: Array<{ label: string; value: WatchStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
];

/** Today's date as YYYY-MM-DD in IST (en-CA locale yields ISO format). */
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function WatchPage() {
  const [filter, setFilter] = useState<WatchStatus | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIST());
  const { entries, loading, error } = useWatchEntries(filter, date);
  const { account } = usePaperAccount();
  const { data: comparison } = useDailyComparison(date);
  const activeCount = entries.filter(e => e.status === 'WATCHING' || e.status === 'TRADED').length;

  return (
    <div className="p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h1 className="text-2xl font-semibold text-[var(--color-text-primary)]">Watch Monitor</h1>
        <div className="flex items-center gap-4">
          <PaperAccountBadge />
          <div className="text-sm text-[var(--color-text-muted)]">{activeCount} / 50 active slots</div>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto px-2 py-1 text-sm rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <>
          {comparison && <ComparisonStrip data={comparison} date={date} />}
          {(() => {
            // "Real P/L" is the authoritative paper-account result
            // (equity − startingCapital) — the single source of truth, no
            // reconstruction. Fall back to the entry-derived figure only
            // while the account is still loading. "What-if" stays the
            // reconstruction over alerts that were never actually traded.
            const { real: fallbackReal, whatIf, missed } = pnlBreakdown(
              entries, account?.unrealizedPnl,
            );
            const acct = account ? accountRealPnl(account) : null;
            const real = acct ? acct.total : fallbackReal;
            const fmt = (n: number) =>
              `${n >= 0 ? '+' : ''}₹${Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(0)}`;
            const colorOf = (n: number) =>
              n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]';
            return (
              <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <div
                  title={
                    acct
                      ? 'Authoritative account P&L: equity − starting capital. ' +
                        'Realized + open positions + pending (deferred wins released at 18:00).'
                      : 'Realized + open positions.'
                  }
                >
                  <span className="text-[var(--color-text-muted)]">Real P/L: </span>
                  <span className={`font-semibold tabular-nums ${colorOf(real)}`}>{fmt(real)}</span>
                  {acct && (
                    <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                      (realized {fmt(acct.realized)} · open {fmt(acct.unrealized)} · pending {fmt(acct.pending)})
                    </span>
                  )}
                </div>
                <div
                  title="Hypothetical P/L of alerts that were scored but never actually traded — not real money, never deployed."
                >
                  <span className="text-[var(--color-text-muted)]">What-if (untraded alerts): </span>
                  <span className={`tabular-nums ${colorOf(whatIf)}`}>{fmt(whatIf)}</span>
                </div>
                {missed !== 0 && (
                  <div title="What-if P&L of MISSED alerts — reached their target/stop but were never executable (gate-rejected, e.g. price already ran past the alert). Shows how much was missed; not real money.">
                    <span className="text-[var(--color-text-muted)]">Missed (gate-rejected): </span>
                    <span className={`tabular-nums ${colorOf(missed)}`}>~{fmt(missed)}</span>
                  </div>
                )}
              </div>
            );
          })()}
          <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} />

          {(() => {
            // Day-realised summary footer: gross / charges / net for the
            // closed trades currently visible. Mirrors the date filter
            // (reads from the same `entries` the table renders), so the
            // numbers move with the date picker. Only renders when there's
            // at least one closed-and-traded entry — otherwise we'd show a
            // misleading "₹0 net".
            const s = dayRealizedSummary(entries);
            if (s.count === 0) return null;
            const fmt = (n: number) =>
              `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toFixed(2)}`;
            const colorOf = (n: number) =>
              n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]';
            return (
              <div className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    Day realised — {s.count} closed trade{s.count === 1 ? '' : 's'}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 tabular-nums">
                    <div title="Sum of price-only P&L across closed trades, before SEBI/exchange/STT charges.">
                      <span className="text-[var(--color-text-muted)]">Gross </span>
                      <span className={`font-semibold ${colorOf(s.gross)}`}>{fmt(s.gross)}</span>
                    </div>
                    <div title="Round-trip SEBI + exchange + STT + GST + stamp duty + brokerage on the closed trades. Always reduces net.">
                      <span className="text-[var(--color-text-muted)]">Charges </span>
                      <span className="font-semibold text-amber-400">−₹{s.charges.toFixed(2)}</span>
                    </div>
                    <div title="What you actually pocket: Gross − Charges. The number that matters.">
                      <span className="text-[var(--color-text-muted)]">Net </span>
                      <span className={`font-semibold ${colorOf(s.net)}`}>{fmt(s.net)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
