import React, { useState } from 'react';
import clsx from 'clsx';
import { useSwingEntries } from '../../hooks/useSwingEntries';
import { useSwingExits } from '../../hooks/useSwingExits';
import { useSwingOpenBook } from '../../hooks/useSwingOpenBook';
import { useSwingCapital } from '../../hooks/useSwingCapital';
import { useSwingDailyOhlc } from '../../hooks/useSwingDailyOhlc';
import { summarizeOpenBook } from '../../utils/swingOpenBook';
import { CapitalStrip } from '../../components/anand/CapitalStrip';
import { SymbolChartLink } from '../../components/common';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import { useAuthStore } from '../../stores/auth-store';
import { useSubscriptions, shouldShowSubscribeCard } from '../../hooks/useSubscriptions';
import { SubscribeCard } from '../../components/product/SubscribeCard';
import type { AnandEntry, PnlPeriod, PnlSummary } from '../../services/anand';

const ENTRY_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
] as const;

const EXIT_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
] as const;

const NOTIONAL = 200_000;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** IST date N days before today, as YYYY-MM-DD. Used to default the Recent
 *  Exits window to a recent lookback so multi-day cuts aren't hidden. */
function daysAgoIST(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

const rsFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function fmtRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${rsFmt.format(Math.abs(n))}`;
}

function rsColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}

function fmtIstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
  });
}

/** Readable "Jun 09" style day label for the OHLC detail table. */
function fmtOhlcDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
  });
}

/** IST calendar day (YYYY-MM-DD) of an ISO timestamp, for exit-day matching. */
function istDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Collapse a lossless ISO-timestamp lead log to distinct IST calendar days, newest first. */
function distinctDays(isoList: string[]): string[] {
  const seen = new Set<string>();
  for (const iso of isoList) {
    seen.add(new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit' }));
  }
  return [...seen].reverse();
}

function daysElapsed(enteredAt: string, exitedAt: string | null): number {
  const start = new Date(enteredAt).getTime();
  const end = exitedAt ? new Date(exitedAt).getTime() : Date.now();
  const d = Math.ceil((end - start) / 86_400_000);
  return d <= 0 ? 1 : d;
}

function PnlCard({ label, period }: { label: string; period: PnlPeriod }) {
  const hasTrades = period.count > 0;
  const value = hasTrades ? period.totalPnlRs : 0;
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx('mt-1 text-lg font-semibold tabular-nums', hasTrades ? rsColor(value) : 'text-[var(--color-text-muted)]')}>
        {hasTrades ? fmtRs(value) : '—'}
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
        {period.count}t · {period.winCount}W
      </div>
    </div>
  );
}

function PnlCards({ pnl }: { pnl: PnlSummary }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PnlCard label="Daily P&L" period={pnl.daily} />
      <PnlCard label="Weekly P&L" period={pnl.weekly} />
      <PnlCard label="Monthly P&L" period={pnl.monthly} />
      <PnlCard label="Yearly P&L" period={pnl.yearly} />
    </div>
  );
}

/** Lazy-loaded day-wise OHLC table for an expanded swing trade. Mounted only
 *  while the row is expanded, so the fetch fires on expand. Visually
 *  subordinate: smaller text, muted header. */
function SwingOhlcDetail({ entry }: { entry: AnandEntry }) {
  const { data, loading, error } = useSwingDailyOhlc(entry.id, true);
  const exitDay = entry.exitedAt ? istDayKey(entry.exitedAt) : null;

  if (loading) return <div className="px-3 py-3 text-xs text-[var(--color-text-muted)]">Loading OHLC…</div>;
  if (error) return <div className="px-3 py-3 text-xs text-red-400">Error: {error}</div>;
  if (!data || data.rows.length === 0)
    return <div className="px-3 py-3 text-xs text-[var(--color-text-muted)]">No OHLC recorded yet.</div>;

  return (
    <div className="overflow-hidden rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
      <table className="w-full text-xs">
        <thead className="text-left uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-1.5 font-medium">Date</th>
            <th className="px-3 py-1.5 text-right font-medium">Open</th>
            <th className="px-3 py-1.5 text-right font-medium">High</th>
            <th className="px-3 py-1.5 text-right font-medium">Low</th>
            <th className="px-3 py-1.5 text-right font-medium">Close</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const isExit = exitDay != null && istDayKey(r.date) === exitDay;
            const postExit = r.phase === 'POST_EXIT';
            return (
              <tr
                key={r.date}
                className={clsx(
                  'border-t border-[var(--color-border-subtle)]',
                  postExit && 'bg-[var(--color-bg-tertiary)]/40 text-[var(--color-text-muted)]',
                )}
              >
                <td className="px-3 py-1.5 tabular-nums">
                  {fmtOhlcDate(r.date)}
                  {isExit && (
                    <span className="ml-2 rounded bg-blue-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-blue-300">
                      ← exit
                    </span>
                  )}
                  {postExit && !isExit && (
                    <span className="ml-2 text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      (post-exit)
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{r.open.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{r.high.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{r.low.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{r.close.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EntryRow({ entry, isAdmin }: { entry: AnandEntry; isAdmin: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const ongoing = entry.exitPrice == null;
  const stale = entry.priceStale === true; // only set for open rows with no price
  const pnlPct = entry.pnlPct;
  const pnlColor =
    pnlPct == null ? 'text-[var(--color-text-muted)]' : pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const pnlRs = pnlPct == null ? null : (pnlPct / 100) * NOTIONAL;
  const statusColor: Record<string, string> = {
    TRADED: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        {/* 1. Symbol */}
        <td className="px-3 py-2 font-mono font-medium">
          <span
            aria-hidden
            className="mr-1.5 inline-block w-3 text-[var(--color-text-muted)]"
          >
            {expanded ? '▾' : '▸'}
          </span>
          <SymbolChartLink symbol={entry.symbol} token={entry.token} />
          {ongoing && (
            <span className="ml-2 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
              Overnight
            </span>
          )}
        </td>
        {/* Provenance: Scanner — ADMIN only */}
        {isAdmin && (
          <td className="px-3 py-2 text-[var(--color-text-secondary)]">
            {entry.scannerName ?? <span className="text-[var(--color-text-muted)]">—</span>}
          </td>
        )}
        {/* Provenance: Leads — ADMIN only */}
        {isAdmin && (
          <td className="px-3 py-2 tabular-nums">
            {entry.leadCount && entry.leadCount > 0 ? (
              <span
                title={distinctDays(entry.leadDates ?? []).join('\n')}
                className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-text-secondary)]"
              >
                ×{entry.leadCount}
              </span>
            ) : (
              <span className="text-[var(--color-text-muted)]">—</span>
            )}
          </td>
        )}
        {/* 3. Entry Price */}
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        {/* 4. Price / Δ% */}
        <td className={clsx('px-3 py-2 tabular-nums', pnlColor)}>
          {stale ? (
            <span
              className="text-[var(--color-text-muted)]"
              title="No live price available right now — showing no data instead of a stale estimate"
            >
              —
              <span className="ml-1 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase text-amber-300">
                stale
              </span>
            </span>
          ) : (
            <>
              ₹{(ongoing ? (entry.currentPrice as number) : (entry.exitPrice as number)).toFixed(2)}
              {pnlPct != null && <span className="ml-1 text-xs">{fmtPct(pnlPct)}</span>}
            </>
          )}
        </td>
        {/* 5. P&L ₹ */}
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlRs == null ? 'text-[var(--color-text-muted)]' : rsColor(pnlRs))}>
          {pnlRs == null ? '—' : fmtRs(pnlRs)}
        </td>
        {/* 6. P&L % */}
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {pnlPct == null ? '—' : fmtPct(pnlPct)}
        </td>
        {/* 7. Target */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{entry.targetPct}%</td>
        {/* 8. Status */}
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status.replace('_', ' ')}
        </td>
        {/* 9. Entry Time */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstTime(entry.enteredAt)}</td>
        {/* 10. Start Date */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstDate(entry.enteredAt)}</td>
        {/* 11. End Date */}
        <td className="px-3 py-2 tabular-nums">
          {entry.exitedAt ? (
            <span className="text-[var(--color-text-muted)]">{fmtIstDate(entry.exitedAt)}</span>
          ) : (
            <span className="italic text-gray-500">Ongoing</span>
          )}
        </td>
        {/* 12. Days */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {daysElapsed(entry.enteredAt, entry.exitedAt)}d
        </td>
      </tr>
      {/* Provenance: click-to-expand score breakdown — ADMIN only */}
      {isAdmin && expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={13} className="px-3 py-2">
            <ChartinkScoreTable
              score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
              lotCount={0}
              checks={entry.scoreBreakdown}
            />
          </td>
        </tr>
      )}
      {expanded && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={isAdmin ? 13 : 11} className="px-3 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Daily OHLC
            </div>
            <SwingOhlcDetail entry={entry} />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

/** Shared table for both the Open Book and the date-filtered Entries log. */
function EntriesTable({
  entries,
  loading,
  error,
  emptyMessage,
  isAdmin,
}: {
  entries: AnandEntry[];
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  isAdmin: boolean;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2">Symbol</th>
            {/* Provenance: Scanner + Leads — ADMIN only */}
            {isAdmin && <th className="px-3 py-2">Scanner</th>}
            {isAdmin && <th className="px-3 py-2">Leads</th>}
            <th className="px-3 py-2">Entry ₹</th>
            <th className="px-3 py-2">Price / Δ%</th>
            <th className="px-3 py-2">P&L ₹</th>
            <th className="px-3 py-2">P&L %</th>
            <th className="px-3 py-2">Target</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Entry Time</th>
            <th className="px-3 py-2">Start Date</th>
            <th className="px-3 py-2">End Date</th>
            <th className="px-3 py-2">Days</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 13 : 11} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                {emptyMessage}
              </td>
            </tr>
          )}
          {entries.map((e) => <EntryRow key={e.id} entry={e} isAdmin={isAdmin} />)}
        </tbody>
      </table>
    </div>
  );
}

export default function SwingPage() {
  // NOTE: all hooks are called unconditionally before any early return, so the
  // hook order is stable regardless of role/subscription branching below.
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(todayIST());
  // Default exit window is a wide 90-day lookback so a recently-closed trade is
  // never silently hidden (the old 7-day default cut off an 8-day-old
  // target-hit). When a SPECIFIC terminal status is selected below, the date
  // floor is dropped entirely (all-time for that status) so it's always findable.
  const [exitFrom, setExitFrom] = useState(daysAgoIST(90));
  const [exitStatus, setExitStatus] = useState<string | undefined>(undefined);
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'ADMIN';
  const subs = useSubscriptions();
  // Only fetch the plan-gated data once access is known — otherwise an
  // unsubscribed USER fires 403s that would flash before the gate resolves.
  const canView = isAdmin || subs.swing;
  const { entries, pnl, loading, error } = useSwingEntries(filter, from, canView);
  // Recent Exits: closed/exited swing positions filtered by EXIT date and
  // status. The Entries log above filters by ENTRY date, so a multi-day swing
  // entered earlier but cut recently shows nowhere — this section surfaces it.
  // Selecting a specific status shows ALL-TIME results for it (no date floor).
  const { exits, loading: exitsLoading, error: exitsError } = useSwingExits(
    exitStatus ? undefined : exitFrom,
    exitStatus,
    canView,
  );
  // Capital summary: engaged vs available, recycles as positions exit.
  const { capital } = useSwingCapital(canView);
  // Total realized P&L of the listed exits, using the same per-row notional
  // basis EntryRow uses for its P&L ₹ column ((pnlPct / 100) * NOTIONAL).
  const exitsRealizedRs = exits.reduce(
    (sum, e) => sum + (e.pnlPct == null ? 0 : (e.pnlPct / 100) * NOTIONAL),
    0,
  );
  // Open Book: every currently-open position (status TRADED), with NO date
  // filter — the live-exposure source of truth. Kept separate from the
  // date-filtered `entries` above so overnight/multi-day positions are always
  // visible and counted, even when the From date excludes their entry day.
  const { openEntries, loading: openLoading, error: openError } = useSwingOpenBook(canView);
  const { openCount, invested, currentValue, unrealizedRs } = summarizeOpenBook(openEntries, NOTIONAL);

  // While the subscription status is still resolving, show a quiet loading
  // state — NOT the tables (which would surface the gated data calls' 403s).
  if (!isAdmin && subs.loading) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="text-[var(--color-text-muted)]">Loading…</div>
      </div>
    );
  }

  // Gate: an unsubscribed USER (non-admin) sees the Subscribe placeholder
  // instead of the signals tables. Branch happens AFTER all hooks above.
  if (shouldShowSubscribeCard(isAdmin, subs.loading, subs.swing)) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <SubscribeCard segment="Swing" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">{openCount} open</span>
          {openCount > 0 && (
            <span
              title="Unrealized P&L of open positions (mark-to-market, not yet booked)"
              className={clsx(
                'rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs font-semibold tabular-nums',
                rsColor(unrealizedRs),
              )}
            >
              {fmtRs(unrealizedRs)} unrealized
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
          available={capital?.available}
          realizedRs={capital?.realizedPnl}
        />
      )}

      {pnl && <PnlCards pnl={pnl} />}

      {/* Open Book — every currently-open position, always shown regardless of
          the date filter below. This is the live book that holds overnight. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Open Book · {openCount} open
        </h2>
        <EntriesTable
          entries={openEntries}
          loading={openLoading}
          error={openError}
          emptyMessage="No open positions."
          isAdmin={isAdmin}
        />
      </section>

      {/* Entries log — date- and status-filtered history, for auditing what
          fired on a given day. These controls scope only this section. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Entries
        </h2>
        <div className="flex flex-wrap gap-2">
          {ENTRY_FILTERS.map((f) => (
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
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <label>From:</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
            />
          </div>
        </div>

        <EntriesTable
          entries={entries}
          loading={loading}
          error={error}
          emptyMessage="No swing entries yet. Waiting for Anand Swing scanner alerts."
          isAdmin={isAdmin}
        />
      </section>

      {/* Recent Exits — closed positions filtered by EXIT date. Surfaces
          multi-day swings entered earlier but cut recently, which the
          entry-date-filtered Entries log above cannot show. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Recent Exits
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {EXIT_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setExitStatus(f.value)}
              className={clsx(
                'rounded px-3 py-1 text-sm transition-colors',
                exitStatus === f.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {f.label}
            </button>
          ))}
          {exits.length > 0 && (
            <span className="text-sm text-[var(--color-text-muted)]">
              {exits.length} exit{exits.length === 1 ? '' : 's'} ·{' '}
              <span className={rsColor(exitsRealizedRs)}>{fmtRs(exitsRealizedRs)} realized</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            {exitStatus ? (
              <span className="italic">Showing all-time {exitStatus.replace('_', ' ').toLowerCase()} exits</span>
            ) : (
              <>
                <label>Exited from:</label>
                <input
                  type="date"
                  value={exitFrom}
                  onChange={(e) => setExitFrom(e.target.value)}
                  className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
                />
              </>
            )}
          </div>
        </div>

        <EntriesTable
          entries={exits}
          loading={exitsLoading}
          error={exitsError}
          emptyMessage="No swing exits in this range."
          isAdmin={isAdmin}
        />
      </section>
    </div>
  );
}
