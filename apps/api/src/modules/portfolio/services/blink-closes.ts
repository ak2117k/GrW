import type { LiveTrackerRow } from '../repositories/live-trades.repository';

/** A re-open within this long after a close, at the same price and qty, means the close was a book blink. */
export const BLINK_REOPEN_MS = 35 * 60_000;
const SAME_PRICE = 0.005;

/**
 * Drops the CLOSED tracker rows that were never real exits (2026-11-02). Until the tracker's blink grace,
 * a holding / position missing from one broker read was closed at that moment's mark and re-opened
 * minutes later: 406 such closes summed to −₹2.90L of "realised" P&L (−₹2.60L shown vs ≈ −₹1.21L real).
 * A close followed by a re-open of the same token and kind within BLINK_REOPEN_MS, at an entry price
 * within 0.5 % and the same qty, is a blink: the position simply continued. Rows with no cost (entry 0,
 * an overnight leg read before its cost was repaired) are not trades either. Pure.
 */
export function withoutBlinkCloses(trackers: readonly LiveTrackerRow[]): LiveTrackerRow[] {
  const byKey = new Map<string, LiveTrackerRow[]>();
  for (const t of trackers) {
    const k = `${t.kind}:${t.token}`;
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const blink = new Set<string>();
  for (const rows of byKey.values()) {
    const sorted = [...rows].sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.status !== 'CLOSED' || !a.exitTime) continue;
      const gap = b.entryTime.getTime() - a.exitTime.getTime();
      const samePrice = a.entryPrice > 0 && Math.abs(b.entryPrice - a.entryPrice) <= SAME_PRICE * a.entryPrice;
      if (gap >= 0 && gap <= BLINK_REOPEN_MS && samePrice && b.qty === a.qty) blink.add(a.id);
    }
  }
  return trackers.filter((t) => !blink.has(t.id) && !(t.status === 'CLOSED' && !(t.entryPrice > 0)));
}
