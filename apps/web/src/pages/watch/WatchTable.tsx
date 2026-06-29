import { Fragment } from 'react';
import type { WatchEntry, WatchEntryWithEvents } from '../../types/watch.types';
import { profitView, whatIfView, isClosed, breakdownChecks } from '../../utils/watchPnl';
import { trailView, SL_AMBER_THRESHOLD_PCT } from '../../utils/trailView';
import { WatchDetailPanel } from './WatchDetailPanel';
import { factorCell, type FactorCellState } from './factorCell';
import { FACTOR_COLUMNS } from '../../utils/factorColumns';
import { SymbolChartLink } from '../../components/common';

interface Props {
  entries: WatchEntry[];
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  fetchEntry?: (id: string) => Promise<WatchEntryWithEvents>;
}

function pctChange(curr: number | null, init: number): string {
  if (curr == null) return '—';
  const d = ((curr - init) / init) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
}

function statusLabel(entry: WatchEntry): string {
  if (entry.status === 'TRADED' && entry.partialExitedAt) return 'TRAILING';
  return entry.status;
}

function statusColor(entry: WatchEntry): string {
  if (entry.status === 'TRADED' && entry.partialExitedAt) return 'text-amber-400';
  switch (entry.status) {
    case 'WATCHING': return 'text-blue-400';
    case 'TRADED': return 'text-emerald-400';
    case 'TARGET_HIT': return 'text-emerald-300';
    case 'STOPPED': return 'text-red-400';
    case 'EXITED': return 'text-[var(--color-text-muted)]';
    case 'DISMISSED': return 'text-[var(--color-text-muted)]';
    case 'MISSED': return 'text-amber-500/70';
    default: return 'text-[var(--color-text-secondary)]';
  }
}

function profitColor(abs: number, hasLivePrice: boolean): string {
  if (!hasLivePrice) return 'text-[var(--color-text-muted)]';
  if (abs > 0) return 'text-emerald-400';
  if (abs < 0) return 'text-red-400';
  return 'text-[var(--color-text-secondary)]';
}

function fmtRupees(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}₹${Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(0)}`;
}

/** Time-of-day in IST (HH:MM:SS). The day itself is implied by the date filter. */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Kolkata',
  });
}

/** Tailwind class for a factor cell, keyed by its transition state. */
const FACTOR_STATE_CLASS: Record<FactorCellState, string> = {
  same: '',
  decayed: 'text-red-400 font-medium bg-red-500/10 rounded',
  improved: 'text-emerald-300 font-medium bg-emerald-500/10 rounded',
};

export function WatchTable({ entries, onSelect, selectedId, fetchEntry }: Props) {
  if (entries.length === 0) {
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)]">
        No watch entries.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
    <table className="min-w-full text-sm text-[var(--color-text-primary)]">
      <thead className="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className="py-2 px-3 text-left">Symbol</th>
          <th className="py-2 px-3 text-left">Scanner</th>
          <th className="py-2 px-3 text-left">Side</th>
          <th
            className="py-2 px-3 text-right"
            title="Traded rows: actual filled quantity. Untraded (what-if) rows: score-tiered capital ÷ price."
          >
            Qty
          </th>
          <th className="py-2 px-3 text-right">Price</th>
          <th className="py-2 px-3 text-right">Δ%</th>
          <th
            className="py-2 px-3 text-right"
            title="Real rows: live / realized P&L. What-if rows: bounded counterfactual — floored at the −0.4% stop, capped at target, net of charges."
          >
            P&amp;L
          </th>
          <th className="py-2 px-3 text-right">P&amp;L %</th>
          <th className="py-2 px-3 text-right" title="Live stop: hard −0.4% loss-cut before partial exit; trailing stop after.">SL</th>
          <th className="py-2 px-3 text-right" title="Profit target (re-anchored to the live fill on execute).">TP</th>
          <th className="py-2 px-3 text-left">Status</th>
          <th className="py-2 px-3 text-right" title="Order fill time — or the alert time if never traded (IST)">Buy Time</th>
          <th className="py-2 px-3 text-right" title="Position close / alert stop time (IST)">Sell Time</th>
          <th className="py-2 px-3 text-right">Score</th>
          {FACTOR_COLUMNS.map((f) => (
            <th
              key={f.name}
              className="py-2 px-2 text-center font-medium"
              title={`${f.name} — live value; ✓→✗ decayed / ✗→✓ improved since entry`}
            >
              {f.short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          // A what-if row = scored but never actually traded. Its P&L/Qty must
          // come from whatIfView (bounded counterfactual), so the row matches
          // the header's "What-if" total. Real (TRADED / closed-traded) rows
          // keep profitView.
          const isWhatIf =
            !(isClosed(e.status) && e.realizedPnl != null) && e.status !== 'TRADED';
          const p = isWhatIf ? whatIfView(e) : profitView(e);
          const t = trailView(e);
          const slAmber =
            t.state === 'armed' && t.distancePct != null && t.distancePct < SL_AMBER_THRESHOLD_PCT;
          // Buy-time pass/fail per factor.
          const initialByName = new Map(
            breakdownChecks(e.initialBreakdown).map((c) => [c.name, c.passed]),
          );
          // Live pass/fail per factor — falls back to buy-time when never rescored.
          const currentByName = new Map(
            breakdownChecks(e.currentBreakdown ?? e.initialBreakdown).map((c) => [c.name, c.passed]),
          );
          return (
            <Fragment key={e.id}>
            <tr
              onClick={() => onSelect(e.id === selectedId ? null : e.id)}
              className={`border-b border-[var(--color-border-subtle)] cursor-pointer transition-colors ${
                e.id === selectedId
                  ? 'bg-[var(--color-bg-tertiary)]'
                  : 'hover:bg-[var(--color-bg-tertiary)]/50'
              }`}
            >
              <td className="py-2 px-3 font-mono text-[var(--color-text-primary)]">
                <SymbolChartLink symbol={e.symbol} token={e.token} exchange={e.exchange} />
              </td>
              <td
                className="py-2 px-3 text-left text-[var(--color-text-secondary)] max-w-[160px] truncate"
                title={e.scannerName ?? undefined}
              >
                {e.scannerName ?? '—'}
              </td>
              <td className="py-2 px-3 text-[var(--color-text-secondary)]">{e.side}</td>
              <td
                className="py-2 px-3 text-right tabular-nums text-[var(--color-text-primary)]"
                title={`₹${(p.qty * p.ref).toLocaleString('en-IN', { maximumFractionDigits: 0 })} deployed @ ₹${p.ref.toFixed(2)}`}
              >
                {p.qty.toLocaleString('en-IN')}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.currentPrice?.toFixed(2) ?? (e.executedPrice ?? e.initialPrice).toFixed(2)}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {pctChange(e.currentPrice, e.executedPrice ?? e.initialPrice)}
              </td>
              {e.status === 'MISSED' ? (
                // Reached its level but was never traded (gate-rejected). Show
                // the what-if P&L (marked ~, amber) so the missed amount is
                // visible — but it never counts toward Real P/L (see WatchPage).
                <>
                  <td
                    className="py-2 px-3 text-right tabular-nums text-amber-500/80"
                    title="MISSED — alert reached its level but was never traded (gate-rejected). What-if amount only; not real money."
                  >
                    ~{fmtRupees(p.abs)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-amber-500/80">
                    ~{p.pct >= 0 ? '+' : ''}{p.pct.toFixed(2)}%
                  </td>
                </>
              ) : isClosed(e.status) ? (
                e.realizedPnl != null ? (
                  // Executed & closed → realized P&L from the linked trade.
                  <>
                    <td className={`py-2 px-3 text-right font-medium tabular-nums ${
                      e.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {fmtRupees(e.realizedPnl)}
                    </td>
                    <td className={`py-2 px-3 text-right tabular-nums ${
                      e.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {`${e.realizedPnl >= 0 ? '+' : ''}${(
                        (e.realizedPnl / Math.max(p.ref * p.qty, 1)) * 100
                      ).toFixed(2)}%`}
                    </td>
                  </>
                ) : (
                  // Never traded → "what-if" P&L (price-based, hypothetical).
                  // Marked with ~ and a tooltip so it is not read as real money.
                  <>
                    <td
                      className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                      title="What-if P&L — this alert was never traded"
                    >
                      ~{fmtRupees(p.abs)}
                    </td>
                    <td
                      className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                      title="What-if — this alert was never traded"
                    >
                      ~{p.pct >= 0 ? '+' : ''}{p.pct.toFixed(2)}%
                    </td>
                  </>
                )
              ) : (
                <>
                  <td
                    className={`py-2 px-3 text-right font-medium tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                    title={`${p.qty} shares @ ₹${p.ref.toFixed(2)} = ₹${(p.qty * p.ref).toFixed(0)} invested`}
                  >
                    {p.hasLivePrice ? fmtRupees(p.abs) : '—'}
                  </td>
                  <td className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}>
                    {p.hasLivePrice ? `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(2)}%` : '—'}
                  </td>
                </>
              )}
              <td
                className={`py-2 px-3 text-right tabular-nums ${
                  slAmber ? 'text-amber-400' : 'text-[var(--color-text-primary)]'
                }`}
                title={t.slKind ? `${t.slKind} stop` : undefined}
              >
                {t.slPrice != null ? (
                  <>
                    ₹{t.slPrice.toFixed(2)}
                    <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{t.slKind}</span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">—</span>
                )}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {e.profitTarget.toFixed(2)}
              </td>
              <td className={`py-2 px-3 font-medium ${statusColor(e)}`}>{statusLabel(e)}</td>
              <td className="py-2 px-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                {fmtTime(e.executedAt ?? e.initialAt)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                {fmtTime(e.closedAt)}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.initialScore}
                {e.currentScore != null && e.currentScore !== e.initialScore ? (
                  <> → <strong>{e.currentScore}</strong></>
                ) : null}
              </td>
              {FACTOR_COLUMNS.map((f) => {
                const initial = initialByName.get(f.name);
                const current = currentByName.get(f.name);
                // No data for this factor at all → render the neutral dot.
                if (initial === undefined || current === undefined) {
                  return (
                    <td key={f.name} className="py-2 px-2 text-center">
                      <span className="text-[var(--color-text-muted)]">·</span>
                    </td>
                  );
                }
                const cell = factorCell(initial, current);
                const title =
                  cell.state === 'decayed'
                    ? `${f.name} — passed at entry, now failing`
                    : cell.state === 'improved'
                    ? `${f.name} — failed at entry, now passing`
                    : `${f.name} — ${current ? 'aligned' : 'not aligned'}`;
                const sameClass = current ? 'text-emerald-400' : 'text-red-400/60';
                return (
                  <td key={f.name} className="py-2 px-2 text-center" title={title}>
                    <span
                      className={
                        cell.state === 'same'
                          ? sameClass
                          : `px-1 py-0.5 ${FACTOR_STATE_CLASS[cell.state]}`
                      }
                    >
                      {cell.text}
                    </span>
                  </td>
                );
              })}
            </tr>
            {e.id === selectedId && (
              <tr>
                <td
                  colSpan={24}
                  className="p-2 bg-[var(--color-bg-tertiary)]/40 border-b border-[var(--color-border-subtle)]"
                >
                  <WatchDetailPanel
                    entryId={e.id}
                    entry={e}
                    onClose={() => onSelect(null)}
                    fetchEntry={fetchEntry}
                  />
                </td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
