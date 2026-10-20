// apps/api/src/modules/mbm/domain/stock-chain.ts
// Pure pieces of the per-symbol (stock / non-NIFTY) chain capture (MBM_CHAIN_CAPTURE_STOCKS): the
// 15-minute cadence + 15:30 EOD window, symbol normalising, and packing every symbol's legs into
// ≤50-token quote batches. No I/O. Strike selection reuses chain-snapshot's strikesAround.
import type { NseCalendar } from './bar-window';
import { CAPTURE_FROM_MIN, CAPTURE_TO_MIN } from './chain-snapshot';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Strikes kept each side of ATM for a per-symbol chain (NIFTY keeps 15). */
export const STOCK_STRIKES_AROUND = 10;
/** Only the nearest expiry is captured per symbol. */
export const STOCK_CHAIN_EXPIRIES = 1;
/** Cadence: every 15 minutes in session. */
export const STOCK_CADENCE_MIN = 15;
/** The 15:30 IST snapshot is the session's EOD one. */
export const STOCK_EOD_MIN = CAPTURE_TO_MIN;

/** Minute of the IST day of an instant. */
export function istMinuteOfDay(now: Date): number {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export type StockTick = 'NONE' | 'INTRADAY' | 'EOD';

/**
 * What a stock-chain tick at `now` should do: an NSE trading day, 09:15–15:30 IST, on a 15-minute
 * boundary (09:15, 09:30, …, 15:15) → INTRADAY; exactly 15:30 → EOD; anything else → NONE.
 */
export function stockChainTick(cal: NseCalendar, now: Date): StockTick {
  if (!cal.isTradingDay('NSE', now)) return 'NONE';
  const m = istMinuteOfDay(now);
  if (m < CAPTURE_FROM_MIN || m > CAPTURE_TO_MIN) return 'NONE';
  if ((m - CAPTURE_FROM_MIN) % STOCK_CADENCE_MIN !== 0) return 'NONE';
  return m === STOCK_EOD_MIN ? 'EOD' : 'INTRADAY';
}

/**
 * The instrument-master underlying name of a symbol as callers write it: trimmed, upper-cased, a cash
 * suffix (`RELIANCE-EQ`) dropped. Empty → null.
 */
export function normaliseUnderlying(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim().toUpperCase().replace(/-(EQ|BE)$/, '');
  return s === '' ? null : s;
}

/**
 * Packs per-symbol token lists into batches of at most `max` tokens, in order, splitting a symbol
 * across batches only when it must. Each batch records which symbols it carries, so a failed batch
 * blanks only those symbols.
 */
export function packBatches<T>(groups: ReadonlyArray<{ key: string; items: readonly T[] }>, max: number): Array<{ items: T[]; keys: Set<string> }> {
  const out: Array<{ items: T[]; keys: Set<string> }> = [];
  let cur: { items: T[]; keys: Set<string> } | null = null;
  for (const g of groups) {
    for (const item of g.items) {
      if (!cur || cur.items.length >= max) {
        cur = { items: [], keys: new Set() };
        out.push(cur);
      }
      cur.items.push(item);
      cur.keys.add(g.key);
    }
  }
  return out;
}
