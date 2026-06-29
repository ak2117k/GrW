import type { WatchEntry } from '../../types/watch.types';
import { trailView } from '../../utils/trailView';

interface Props { entry: WatchEntry }

function fmtRupeesInt(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}₹${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * Live trailing-stop state for a watch entry, rendered in WatchDetailPanel.
 *   armed   → metrics grid + plain-English status line.
 *   pending → one-liner: "Trail not armed — arms at +1% (₹X)".
 *   n/a     → nothing (section omitted).
 *
 * Hidden entirely for options legs — the backend's partial-exit / trailing
 * logic is equity-only, so "arms at +1%" would be misleading there.
 */
export function TrailingStopSection({ entry }: Props) {
  if (entry.optionsToken != null) return null;

  const v = trailView(entry);
  if (v.state === 'n/a') return null;

  if (v.state === 'pending') {
    return (
      <div className="text-sm text-[var(--color-text-muted)] mb-4">
        Trailing stop — not armed. Arms at +1% (₹{v.armPrice!.toFixed(2)}).
      </div>
    );
  }

  // armed
  const isFinal = entry.status !== 'TRADED';
  const curr = entry.currentPrice;
  return (
    <div className="mb-4 p-3 bg-[var(--color-bg-tertiary)]/40 rounded border border-[var(--color-border-subtle)]">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-[var(--color-text-muted)]">Trailing stop</div>
        {isFinal && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
            final
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Half-exit</span>
          <span className="text-[var(--color-text-primary)]">
            {v.partialQty} @ ₹{v.partialExitPrice!.toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Realised</span>
          <span className={v.realised! >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {fmtRupeesInt(v.realised!)}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Remaining</span>
          <span className="text-[var(--color-text-primary)]">{v.remainingQty} shares</span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">High-water</span>
          <span className="text-[var(--color-text-primary)]">
            {v.highWater != null ? `₹${v.highWater.toFixed(2)}` : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Trail stop</span>
          <span className="text-[var(--color-text-primary)]">
            {v.trailStop != null ? `₹${v.trailStop.toFixed(2)}` : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Distance</span>
          <span className="text-[var(--color-text-primary)]">
            {v.distancePct != null ? fmtPct(v.distancePct) : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Protected</span>
          <span className={v.protected != null && v.protected >= 0 ? 'text-emerald-400' : v.protected != null ? 'text-red-400' : 'text-[var(--color-text-muted)]'}>
            {v.protected != null ? fmtRupeesInt(v.protected) : '—'}
          </span>
        </div>
        <div>
          <span className="text-[var(--color-text-muted)] mr-2">Locked total</span>
          <span className={`font-medium ${v.lockedTotal != null && v.lockedTotal >= 0 ? 'text-emerald-400' : v.lockedTotal != null ? 'text-red-400' : 'text-[var(--color-text-muted)]'}`}>
            {v.lockedTotal != null ? fmtRupeesInt(v.lockedTotal) : '—'}
          </span>
        </div>
      </div>

      <div className="text-xs text-[var(--color-text-secondary)] mt-2">
        ▸ Trailing 0.5% under the ₹{v.highWater?.toFixed(2) ?? '—'} high-water — price
        {curr != null ? ` ₹${curr.toFixed(2)}` : ''} is{' '}
        {v.distancePct != null ? fmtPct(v.distancePct) : '—'} above the stop.
        {v.lockedTotal != null && <> {fmtRupeesInt(v.lockedTotal)} secured.</>}
      </div>
    </div>
  );
}
