import React, { useState } from 'react';
import clsx from 'clsx';
import { useIntradayEntries } from '../../hooks/useIntradayEntries';
import { summarizeOpenBook } from '../../utils/swingOpenBook';
import { CapitalStrip } from '../../components/anand/CapitalStrip';
import { SymbolChartLink } from '../../components/common';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import { useAuthStore } from '../../stores/auth-store';
import { useSubscriptions, shouldShowSubscribeCard } from '../../hooks/useSubscriptions';
import { SubscribeCard } from '../../components/product/SubscribeCard';
import type { AnandEntry, PnlPeriod, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Expired', value: 'EXPIRED' },
] as const;

const NOTIONAL = 200_000; // ₹2L fixed notional per trade

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** Format a rupee value with explicit +/- sign and ₹ prefix, e.g. +₹14,200 / −₹8,400 */
function fmtSignedRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${inrFmt.format(Math.abs(Math.round(n)))}`;
}

/** Color class for a rupee/percent value: green >0, red <0, muted otherwise */
function moneyColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}

function fmtTimeIST(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function PnlCard({ label, period }: { label: string; period: PnlPeriod }) {
  const hasTrades = period.count > 0;
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div
        className={clsx(
          'mt-1 text-xl font-semibold tabular-nums',
          hasTrades ? moneyColor(period.totalPnlRs) : 'text-[var(--color-text-muted)]',
        )}
      >
        {hasTrades ? fmtSignedRs(period.totalPnlRs) : '—'}
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text-muted)] tabular-nums">
        {hasTrades ? `${period.count}t · ${period.winCount}W` : '— · —'}
      </div>
    </div>
  );
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PnlCard label="Daily P&L" period={pnl.daily} />
      <PnlCard label="Weekly P&L" period={pnl.weekly} />
      <PnlCard label="Monthly P&L" period={pnl.monthly} />
      <PnlCard label="Yearly P&L" period={pnl.yearly} />
    </div>
  );
}

function EntryRow({ entry, isAdmin }: { entry: AnandEntry; isAdmin: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = entry.exitPrice == null;
  const stale = entry.priceStale === true; // only set for open rows with no price
  const pnlPct = entry.pnlPct;
  const pnlColor = pnlPct == null ? 'text-[var(--color-text-muted)]' : moneyColor(pnlPct);
  const pnlRs = pnlPct == null ? null : (pnlPct / 100) * NOTIONAL;
  const priceShown = isActive ? entry.currentPrice : entry.exitPrice ?? 0;
  const statusColor: Record<string, string> = {
    TRADED: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
    EXPIRED: 'text-gray-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <td className="px-3 py-2 font-mono font-medium">
          <SymbolChartLink symbol={entry.symbol} token={entry.token} />
        </td>
        {/* Provenance: Scanner — ADMIN only */}
        {isAdmin && (
          <td className="px-3 py-2 text-[var(--color-text-muted)]">
            {entry.scannerName ?? <span className="text-gray-500">—</span>}
          </td>
        )}
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className={clsx('px-3 py-2 tabular-nums', pnlColor)}>
          {stale ? (
            <span
              className="text-[var(--color-text-muted)]"
              title="No live price available right now — showing no data instead of a stale estimate"
            >
              —{' '}
              <span className="rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase text-amber-300">
                stale
              </span>
            </span>
          ) : (
            <>
              ₹{(priceShown as number).toFixed(2)}{' '}
              {pnlPct != null && <span className="text-xs">({fmtPct(pnlPct)})</span>}
            </>
          )}
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlRs == null ? 'text-[var(--color-text-muted)]' : moneyColor(pnlRs))}>
          {pnlRs == null ? '—' : fmtSignedRs(pnlRs)}
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {pnlPct == null ? '—' : fmtPct(pnlPct)}
        </td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{entry.targetPct}%</td>
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status.replace('_', ' ')}
          {/* Provenance: trailing/exitReason badges — ADMIN only */}
          {isAdmin && isActive && entry.trailing && (
            <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-300">trailing</span>
          )}
          {isAdmin && !isActive && entry.exitReason && (
            <span className="ml-1 text-[9px] lowercase text-[var(--color-text-muted)]">
              {entry.exitReason === 'TRAIL_ST' ? 'trail·st' : entry.exitReason === 'TRAIL_GB' ? 'trail·gb' : entry.exitReason.toLowerCase()}
            </span>
          )}
        </td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {fmtTimeIST(entry.enteredAt)}
        </td>
      </tr>
      {/* Provenance: click-to-expand score breakdown — ADMIN only */}
      {isAdmin && expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={9} className="px-3 py-2">
            <ChartinkScoreTable
              score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
              lotCount={0}
              checks={entry.scoreBreakdown}
            />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
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
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">{openCount} open</span>
          {openCount > 0 && (
            <span
              title="Unrealized P&L of open positions (mark-to-market, not yet booked)"
              className={clsx(
                'rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs font-semibold tabular-nums',
                moneyColor(unrealizedRs),
              )}
            >
              {fmtSignedRs(unrealizedRs)} unrealized
            </span>
          )}
        </div>
      </div>

      {openCount > 0 && (
        <CapitalStrip
          openCount={openCount}
          invested={invested}
          currentValue={currentValue}
          unrealizedRs={unrealizedRs}
        />
      )}

      {pnl && <PnlBar pnl={pnl} />}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={clsx(
              'rounded px-3 py-1 text-sm transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text-secondary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                {isAdmin && <th className="px-3 py-2">Scanner</th>}
                <th className="px-3 py-2">Entry Price</th>
                <th className="px-3 py-2">Price / Δ%</th>
                <th className="px-3 py-2">P&L ₹</th>
                <th className="px-3 py-2">P&L %</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Entry Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No entries yet. Tag an Anand Swing scanner as ANAND_SWING to start auto-logging.
                  </td>
                </tr>
              )}
              {entries.map((e) => <EntryRow key={e.id} entry={e} isAdmin={isAdmin} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
