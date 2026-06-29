import type { WatchEntry } from '../types/watch.types';

/** Max ₹ deployed per trade — mirrors backend MAX_INVESTMENT_PER_TRADE.
 *  Legacy fallback only: used by profitView when an entry has no persisted
 *  real quantity. whatIfView sizes untraded alerts via tierCapital() instead. */
export const MAX_INVESTMENT_PER_TRADE = 200_000;

export interface ProfitView {
  abs: number;
  pct: number;
  ref: number;
  qty: number;
  hasLivePrice: boolean;
}

/**
 * Live price-based P/L for an open entry: currentPrice vs reference
 * (executedPrice for TRADED, initialPrice for WATCHING), side-adjusted,
 * × qty = remainingQty ?? quantity ?? floor(MAX_INVESTMENT_PER_TRADE / ref)
 *   (the last form is a legacy fallback for entries persisted before the real
 *   quantity was tracked).
 */
export function profitView(entry: WatchEntry): ProfitView {
  const ref = entry.executedPrice ?? entry.initialPrice;
  const curr = entry.currentPrice ?? ref;
  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const diff = (curr - ref) * sideMul;
  // Real position size: the trailing remainder after a partial exit, else the
  // full filled quantity. floor(MAX/price) is only a fallback for legacy
  // entries persisted before the real quantity was tracked.
  const qty =
    entry.remainingQty ??
    entry.quantity ??
    Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
  return {
    abs: diff * qty,
    pct: ref > 0 ? (diff / ref) * 100 : 0,
    ref,
    qty,
    hasLivePrice: entry.currentPrice != null,
  };
}

/** Score-tiered capital (₹) for a hypothetical trade — mirrors backend R4
 *  evaluateTradePolicy tiers: [60,65)->1L, [65,75)->1.5L, [75,inf)->2L. The
 *  11:45-14:00 IST flat-1L window is intentionally omitted (a documented
 *  what-if approximation). */
function tierCapital(score: number): number {
  if (score < 65) return 100_000;
  if (score < 75) return 150_000;
  return 200_000;
}

/** Estimated round-trip SEBI/exchange charges for a hypothetical NSE
 *  equity-intraday trade — mirrors the backend trade-charges model (R6):
 *  a BUY entry leg + a SELL exit leg. `turnover` is the per-leg value
 *  (entry ~= exit for a what-if estimate). */
function estimateRoundTripCharges(turnover: number): number {
  const t = Math.max(0, turnover);
  const brokerage = Math.min(t * 0.0003, 20); // 0.03%, capped Rs.20 — each leg
  const exchangeTxn = t * 0.0000297;          // 0.00297% NSE — each leg
  const sebiFee = t * 0.000001;               // Rs.10 per crore — each leg
  const gstPerLeg = (brokerage + exchangeTxn) * 0.18;
  const perLeg = brokerage + exchangeTxn + sebiFee + gstPerLeg;
  const stampDuty = t * 0.00003;              // 0.003% — buy leg only
  const stt = t * 0.00025;                    // 0.025% — sell leg only
  return perLeg + stampDuty + perLeg + stt;
}

/**
 * Bounded what-if P/L for an alert that was scored but never traded — what the
 * trade WOULD have netted under our rules, NOT a raw unbounded mark-to-market:
 *   - entry at initialPrice (the alert price), sized by score-tiered capital (R4)
 *   - floored at the -0.4% hard stop-loss (R5)
 *   - capped at the profit target
 *   - net of round-trip SEBI charges (R6)
 * Returns a ProfitView so the watch table can render a what-if row exactly
 * like a real one. A never-marked entry (no currentPrice) yields abs 0.
 */
export function whatIfView(entry: WatchEntry): ProfitView {
  const ref = entry.initialPrice;
  const qty = Math.max(1, Math.floor(tierCapital(entry.initialScore) / Math.max(ref, 1)));
  const hasLivePrice = entry.currentPrice != null;
  if (!ref || ref <= 0 || !hasLivePrice) {
    return { abs: 0, pct: 0, ref, qty, hasLivePrice };
  }
  const capital = qty * ref;
  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const rawPnl = (entry.currentPrice! - ref) * sideMul * qty;
  const floorPnl = -0.004 * capital; // R5: stopped at -0.4% of deployed capital
  const rawCeil =
    entry.profitTarget != null
      ? (entry.profitTarget - ref) * sideMul * qty // capped at the profit target
      : rawPnl;                                     // no target -> only the floor applies
  // Never let the cap fall below the floor (degenerate target data).
  const ceilPnl = Math.max(rawCeil, floorPnl);
  const gross = Math.min(Math.max(rawPnl, floorPnl), ceilPnl);
  const abs = gross - estimateRoundTripCharges(capital);
  return {
    abs,
    pct: capital > 0 ? (abs / capital) * 100 : 0,
    ref,
    qty,
    hasLivePrice,
  };
}

const CLOSED: ReadonlyArray<string> = ['STOPPED', 'TARGET_HIT', 'EXITED', 'DISMISSED'];

export function isClosed(status: string): boolean {
  return CLOSED.includes(status);
}

/**
 * Section running total — sums each entry's P/L exactly as the P&L column
 * displays it: realized P/L for a closed row that actually traded, otherwise
 * the price-based live / what-if P/L. So the badge always equals the column.
 */
export function sectionTotalPnl(entries: WatchEntry[]): number {
  return entries.reduce((total, e) => {
    // A MISSED alert (reached its level but never executed) shows its what-if
    // P&L in the column so you can see how much was missed — it just never
    // counts toward Real P/L (see pnlBreakdown, which keeps `missed` separate).
    if (isClosed(e.status) && e.realizedPnl != null) {
      return total + e.realizedPnl;
    }
    if (e.status === 'TRADED') {
      return total + profitView(e).abs;
    }
    return total + whatIfView(e).abs;
  }, 0);
}

export interface PnlBreakdown {
  /** Booked P/L from trades that actually closed. Real money. */
  realized: number;
  /** Live unrealized P/L of currently-open (TRADED) positions. Real money. */
  open: number;
  /** Hypothetical P/L of alerts that were scored but never traded. NOT real. */
  whatIf: number;
  /** What-if P/L of MISSED alerts (reached their level but gate-rejected, so
   *  never executable). Shown separately so you can see how much was missed;
   *  NOT real money and excluded from `real`. */
  missed: number;
  /** Real P/L = realized + open. Excludes what-if and missed. */
  real: number;
}

/**
 * Split a watch section's P/L into real money (realized + currently-open) vs
 * hypothetical "what-if" P/L from alerts that were never actually traded — so
 * the header can show the two separately instead of one misleading blend.
 *
 * `accountUnrealizedPnl` — when given (the paper account's `unrealizedPnl`) —
 * replaces the watch-entry-derived `open` slice. The paper account is priced
 * from fresh REST quotes, whereas the watch entries' `currentPrice` is fed by
 * the (token-capped, often stale) WebSocket — so the account figure is the
 * authoritative one, and using it keeps "Real P/L" in sync with the Unreal
 * badge (real === Unreal + realized). When omitted, `open` falls back to the
 * watch-entry estimate.
 *
 * A never-traded entry stays "what-if" even after it is DISMISSED — only
 * entries that genuinely traded are "real".
 */
export function pnlBreakdown(
  entries: WatchEntry[],
  accountUnrealizedPnl?: number | null,
): PnlBreakdown {
  let realized = 0;
  let openFromEntries = 0;
  let whatIf = 0;
  let missed = 0;
  for (const e of entries) {
    if (e.status === 'MISSED') {
      // Reached its level but was never executable — track its what-if P&L in
      // its own bucket so "how much we missed" is visible, but keep it out of
      // realized/open/what-if and therefore out of Real P/L.
      missed += whatIfView(e).abs;
    } else if (isClosed(e.status) && e.realizedPnl != null) {
      realized += e.realizedPnl;
    } else if (e.status === 'TRADED') {
      openFromEntries += profitView(e).abs;
    } else {
      whatIf += whatIfView(e).abs;
    }
  }
  const open =
    accountUnrealizedPnl != null ? accountUnrealizedPnl : openFromEntries;
  return { realized, open, whatIf, missed, real: realized + open };
}

export interface DayRealizedSummary {
  /** How many entries contributed (closed entries with a non-null realizedPnl). */
  count: number;
  /** Sum of trade-engine `pnl` across closed entries — price-only, pre-fees. */
  gross: number;
  /** Sum of trade-engine `fees` across the same set — SEBI/exchange/STT/etc. */
  charges: number;
  /** gross − charges. Net P&L the user actually realises. */
  net: number;
}

/**
 * Summary of *realised* P&L + charges across the watch entries currently in
 * view, intended for the page-bottom footer. Mirrors the top header's date
 * filter (by definition: the footer reads from the same `entries` array).
 *
 * Only closed entries with a non-null `realizedPnl` are summed — open
 * (TRADED) positions and never-traded what-if rows are deliberately
 * excluded, because their fees haven't been booked yet (or never will be).
 * `realizedFees` is null-coerced to 0 so legacy rows without the server-
 * enriched field degrade to gross-only rather than NaN-poisoning the total.
 */
export function dayRealizedSummary(entries: WatchEntry[]): DayRealizedSummary {
  let count = 0;
  let gross = 0;
  let charges = 0;
  for (const e of entries) {
    if (!isClosed(e.status) || e.realizedPnl == null) continue;
    count += 1;
    gross += e.realizedPnl;
    charges += e.realizedFees ?? 0;
  }
  return { count, gross, charges, net: gross - charges };
}

/**
 * Extract the per-check results from a watch-entry breakdown value. Accepts
 * BOTH shapes: the wrapped `{ checks: [...] }` (initialBreakdown, and
 * currentBreakdown since the rescore-shape fix) and a bare `[...]` array
 * (currentBreakdown as persisted by older rescores). Returns [] when the
 * breakdown is absent or malformed — so the factor cells fall back to the
 * neutral dot rather than crashing.
 */
export function breakdownChecks(
  breakdown: unknown,
): Array<{ name: string; passed: boolean }> {
  if (Array.isArray(breakdown)) {
    return breakdown as Array<{ name: string; passed: boolean }>;
  }
  const bd = breakdown as { checks?: Array<{ name: string; passed: boolean }> } | null;
  return Array.isArray(bd?.checks) ? bd!.checks : [];
}

export interface AccountPnl {
  /** equity − startingCapital — the authoritative account P&L. */
  total: number;
  /** Booked P&L so far: balance + deployed capital − starting capital. */
  realized: number;
  /** Unrealized P&L of open positions, mark-to-market. */
  unrealized: number;
  /** Deferred winning profit, released to cash at the 18:00 settlement. */
  pending: number;
}

/**
 * The authoritative account P&L, straight from the paper-account ledger — no
 * reconstruction, no estimated quantities. `total` (equity − startingCapital)
 * is THE real result; realized + unrealized + pending always sum to it. This
 * is the single source of truth the watch page's "Real P/L" displays.
 */
export function accountRealPnl(a: {
  startingCapital: number;
  balance: number;
  deployedCapital: number;
  unrealizedPnl: number;
  pendingProfit: number;
  equity: number;
}): AccountPnl {
  return {
    total: a.equity - a.startingCapital,
    realized: a.balance + a.deployedCapital - a.startingCapital,
    unrealized: a.unrealizedPnl,
    pending: a.pendingProfit,
  };
}
