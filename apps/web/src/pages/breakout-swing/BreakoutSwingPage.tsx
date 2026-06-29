import { useState } from 'react';
import clsx from 'clsx';
import { useBreakoutSwingEntries } from '../../hooks/useBreakoutSwingEntries';
import { useBreakoutSwingCapital } from '../../hooks/useBreakoutSwingCapital';
import { cancelBreakoutSwingOrder, type BreakoutSwingEntry } from '../../services/breakoutSwing';
import { CapitalStrip } from '../../components/anand/CapitalStrip';
import { SymbolChartLink } from '../../components/common';

const TERMINAL_STATUSES = ['TARGET_HIT', 'STOPPED', 'BIG_MOVER_EOD', 'EXPIRED', 'DISMISSED'];

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** IST date N days before today, as YYYY-MM-DD. */
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

/** Compact "3h 12m" / "45m" age since an ISO timestamp. */
function fmtAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ----------------------------- Queued section ----------------------------- */

function QueuedRow({
  entry,
  onCancel,
  cancelling,
}: {
  entry: BreakoutSwingEntry;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  // Distance-to-fill: how far the current price is below the resting limit, as
  // a % of current price. Positive = limit still above market (not yet filling).
  const distPct =
    entry.currentPrice != null && entry.currentPrice > 0
      ? ((entry.limitPrice - entry.currentPrice) / entry.currentPrice) * 100
      : null;

  return (
    <tr className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]">
      <td className="px-3 py-2 font-mono font-medium">
        <SymbolChartLink symbol={entry.symbol} token={entry.token} />
      </td>
      <td className="px-3 py-2 tabular-nums">₹{entry.resistance.toFixed(2)}</td>
      <td className="px-3 py-2 tabular-nums">₹{entry.limitPrice.toFixed(2)}</td>
      <td className="px-3 py-2 tabular-nums">
        {entry.currentPrice == null ? (
          <span className="text-[var(--color-text-muted)]">—</span>
        ) : (
          `₹${entry.currentPrice.toFixed(2)}`
        )}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-secondary)]">
        {distPct == null ? <span className="text-[var(--color-text-muted)]">—</span> : fmtPct(distPct)}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtAge(entry.queuedAt)}</td>
      <td className="px-3 py-2">
        <button
          onClick={() => onCancel(entry.id)}
          disabled={cancelling}
          className={clsx(
            'rounded px-3 py-1 text-xs font-semibold transition-colors',
            cancelling
              ? 'cursor-not-allowed bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'
              : 'bg-red-600/80 text-white hover:bg-red-600',
          )}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </td>
    </tr>
  );
}

function QueuedTable({
  entries,
  loading,
  error,
  onCancel,
  cancellingId,
}: {
  entries: BreakoutSwingEntry[];
  loading: boolean;
  error: string | null;
  onCancel: (id: string) => void;
  cancellingId: string | null;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Resistance</th>
            <th className="px-3 py-2">Limit ₹</th>
            <th className="px-3 py-2">Price</th>
            <th className="px-3 py-2">Dist to Fill</th>
            <th className="px-3 py-2">Age</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                No resting limit orders.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <QueuedRow
              key={e.id}
              entry={e}
              onCancel={onCancel}
              cancelling={cancellingId === e.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------- Open positions section ------------------------ */

function OpenRow({ entry }: { entry: BreakoutSwingEntry }) {
  const entryPrice = entry.entryPrice;
  const pnlPct =
    entryPrice != null && entryPrice > 0 && entry.currentPrice != null
      ? ((entry.currentPrice - entryPrice) / entryPrice) * 100
      : null;
  const pnlColor =
    pnlPct == null ? 'text-[var(--color-text-muted)]' : pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const target = entryPrice != null ? entryPrice * (1 + entry.targetPct / 100) : null;

  return (
    <tr className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]">
      <td className="px-3 py-2 font-mono font-medium">
        <SymbolChartLink symbol={entry.symbol} token={entry.token} />
        {entry.trailing && (
          <span className="ml-2 rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
            Trail
          </span>
        )}
      </td>
      <td className="px-3 py-2 tabular-nums">
        {entryPrice == null ? <span className="text-[var(--color-text-muted)]">—</span> : `₹${entryPrice.toFixed(2)}`}
      </td>
      <td className="px-3 py-2 tabular-nums">
        {entry.currentPrice == null ? (
          <span className="text-[var(--color-text-muted)]">—</span>
        ) : (
          `₹${entry.currentPrice.toFixed(2)}`
        )}
      </td>
      <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
        {pnlPct == null ? '—' : fmtPct(pnlPct)}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {target == null ? '—' : `₹${target.toFixed(2)}`}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {entry.stopPrice == null ? '—' : `₹${entry.stopPrice.toFixed(2)}`}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {entry.enteredAt ? fmtIstTime(entry.enteredAt) : '—'}
      </td>
    </tr>
  );
}

function OpenTable({
  entries,
  loading,
  error,
}: {
  entries: BreakoutSwingEntry[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Entry ₹</th>
            <th className="px-3 py-2">Price</th>
            <th className="px-3 py-2">P&L %</th>
            <th className="px-3 py-2">Target</th>
            <th className="px-3 py-2">Stop</th>
            <th className="px-3 py-2">Entry Time</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                No open positions.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <OpenRow key={e.id} entry={e} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- Recent exits section ------------------------- */

function ExitRow({ entry }: { entry: BreakoutSwingEntry }) {
  const entryPrice = entry.entryPrice;
  const pnlPct =
    entryPrice != null && entryPrice > 0 && entry.exitPrice != null
      ? ((entry.exitPrice - entryPrice) / entryPrice) * 100
      : null;
  const pnlColor =
    pnlPct == null ? 'text-[var(--color-text-muted)]' : pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const statusColor: Record<string, string> = {
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
    BIG_MOVER_EOD: 'text-blue-400',
    EXPIRED: 'text-gray-400',
    DISMISSED: 'text-gray-400',
  };

  return (
    <tr className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]">
      <td className="px-3 py-2 font-mono font-medium">
        <SymbolChartLink symbol={entry.symbol} token={entry.token} />
      </td>
      <td className="px-3 py-2 tabular-nums">
        {entryPrice == null ? <span className="text-[var(--color-text-muted)]">—</span> : `₹${entryPrice.toFixed(2)}`}
      </td>
      <td className="px-3 py-2 tabular-nums">
        {entry.exitPrice == null ? <span className="text-[var(--color-text-muted)]">—</span> : `₹${entry.exitPrice.toFixed(2)}`}
      </td>
      <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
        {pnlPct == null ? '—' : fmtPct(pnlPct)}
      </td>
      <td
        className={clsx(
          'px-3 py-2 text-xs font-semibold uppercase tracking-wider',
          statusColor[entry.status] ?? 'text-gray-400',
        )}
      >
        {entry.status.replace(/_/g, ' ')}
      </td>
      <td className="px-3 py-2 text-[var(--color-text-secondary)]">
        {entry.exitReason ?? <span className="text-[var(--color-text-muted)]">—</span>}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {entry.exitedAt ? `${fmtIstDate(entry.exitedAt)} ${fmtIstTime(entry.exitedAt)}` : '—'}
      </td>
    </tr>
  );
}

function ExitsTable({
  entries,
  loading,
  error,
}: {
  entries: BreakoutSwingEntry[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Entry ₹</th>
            <th className="px-3 py-2">Exit ₹</th>
            <th className="px-3 py-2">P&L %</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Exit Reason</th>
            <th className="px-3 py-2">Exited</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                No exits in this range.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <ExitRow key={e.id} entry={e} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- Page ----------------------------------- */

export default function BreakoutSwingPage() {
  const [from, setFrom] = useState(daysAgoIST(7));
  const { entries, loading, error, refresh } = useBreakoutSwingEntries(from);
  const { capital } = useBreakoutSwingCapital();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const queued = entries.filter((e) => e.status === 'QUEUED');
  const open = entries.filter((e) => e.status === 'TRADED');
  const exits = entries.filter((e) => TERMINAL_STATUSES.includes(e.status));

  const handleCancel = async (id: string) => {
    setCancellingId(id);
    try {
      await cancelBreakoutSwingOrder(id);
      await refresh();
    } catch {
      // toast surfaced by the api interceptor; keep the row visible
    } finally {
      setCancellingId(null);
    }
  };

  // Unrealized P&L across open positions, on actual invested basis.
  const unrealizedRs = open.reduce((sum, e) => {
    if (e.entryPrice == null || e.currentPrice == null) return sum;
    return sum + (e.currentPrice - e.entryPrice) * e.quantity;
  }, 0);

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Breakout Swing</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Resting limit at resistance · 10% target · trailing stop
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">{open.length} open</span>
          {open.length > 0 && (
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

      {capital && (
        <CapitalStrip
          openCount={capital.openCount}
          invested={capital.investedOpen}
          currentValue={capital.investedOpen + unrealizedRs}
          unrealizedRs={unrealizedRs}
          available={capital.available}
          realizedRs={capital.realizedPnl}
        />
      )}

      {/* Queued — resting limit orders waiting to break above resistance. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Queued · {queued.length} resting
        </h2>
        <QueuedTable
          entries={queued}
          loading={loading}
          error={error}
          onCancel={handleCancel}
          cancellingId={cancellingId}
        />
      </section>

      {/* Open positions — limit filled, holding for the breakout move. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Open Positions · {open.length} open
        </h2>
        <OpenTable entries={open} loading={loading} error={error} />
      </section>

      {/* Recent exits — terminal rows, filtered by entry/queue date window. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Recent Exits
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <label>From:</label>
            <input
              type="date"
              value={from}
              max={todayIST()}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
            />
          </div>
        </div>
        <ExitsTable entries={exits} loading={loading} error={error} />
      </section>
    </div>
  );
}
