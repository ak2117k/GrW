/**
 * The stock big-move model's reading, as the API consumers see it
 * (docs/superpowers/plans/2026-10-22-stock-move-contract.md). PURE: rows in, readings / text out.
 *
 * The model (written nightly by the MBM service into `stock_move_scores`) predicts the SIZE of a
 * stock's next-5-session move (|ret| > 1.5 × ATR-equivalent), never its direction. Every consumer
 * treats it as volatility context: shadow (0 points) unless `scorecard.stockMove.points` is tuned on.
 */

export const STOCK_MOVE_HORIZON_DAYS = 5;
export const STOCK_MOVE_THRESHOLD_ATR = 1.5;
/** A book older than this (calendar days) is not served: covers a long weekend plus a holiday. */
export const STOCK_MOVE_MAX_AGE_DAYS = 7;

export type StockMoveBucket = 'TOP20' | 'MID' | 'BOTTOM20';

export interface StockMoveReading {
  symbol: string;
  /** IST session 'YYYY-MM-DD' whose close the features use. */
  asOf: string;
  horizonDays: number;
  pBig: number;
  rankPct: number;
  bucket: StockMoveBucket | string;
  resultsDate: string | null;
  resultsInWindow: boolean;
  modelId: string;
}

/** The `stock_move_scores` columns a reading is built from (Prisma's DATE columns read as UTC midnight). */
export interface StockMoveRow {
  asOf: Date;
  symbol: string;
  horizonDays: number;
  pBig: number;
  rankPct: number;
  bucket: string;
  resultsDate: Date | null;
  resultsInWindow: boolean;
  modelId: string;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function toReading(r: StockMoveRow): StockMoveReading {
  return {
    symbol: normaliseStockSymbol(r.symbol),
    asOf: ymd(r.asOf),
    horizonDays: r.horizonDays,
    pBig: r.pBig,
    rankPct: r.rankPct,
    bucket: r.bucket,
    resultsDate: r.resultsDate ? ymd(r.resultsDate) : null,
    resultsInWindow: r.resultsInWindow,
    modelId: r.modelId,
  };
}

/** NSE cash symbol as the table keys it: upper-case, no `-EQ` / `-BE` series suffix. */
export function normaliseStockSymbol(s: string): string {
  return String(s ?? '').trim().toUpperCase().replace(/-(EQ|BE|BZ|SM|ST)$/, '');
}

/** True when a book dated `asOf` is too old to serve at `now`. */
export function isStale(asOf: string, now: Date, maxAgeDays = STOCK_MOVE_MAX_AGE_DAYS): boolean {
  const t = Date.parse(`${asOf}T00:00:00.000Z`);
  return !Number.isFinite(t) || now.getTime() - t > (maxAgeDays + 1) * 86_400_000;
}

/** `RELIANCE p(big 5d) 0.71 · TOP20 · results 2026-10-24 in window · as of 2026-10-21`. */
export function stockMoveLabel(r: StockMoveReading): string {
  const parts = [`${r.symbol} p(big ${r.horizonDays}d) ${r.pBig.toFixed(2)}`, r.bucket];
  if (r.resultsDate) parts.push(`results ${r.resultsDate}${r.resultsInWindow ? ' in window' : ''}`);
  parts.push(`as of ${r.asOf}`);
  return parts.join(' · ');
}

export const NO_STOCK_MOVE_SCORE = 'no stock-move score yet';

/**
 * The stock part of the expected-move (mood) factor. `setting` is the tuned
 * `scorecard.stockMove.points` (0 = shadow). With 1, a LONG option gets +1 for TOP20 (a big move can
 * outrun theta) and −1 for BOTTOM20 (theta dominates); never a direction vote, never for anything
 * that is not a long option.
 */
export function stockMovePart(
  r: StockMoveReading | null,
  isLongOption: boolean,
  setting: number,
): { points: -1 | 0 | 1; text: string; note: string } {
  if (!r) return { points: 0, text: `stock: ${NO_STOCK_MOVE_SCORE}`, note: '' };
  const text = stockMoveLabel(r);
  if (setting !== 1) return { points: 0, text, note: 'stock big-move model in shadow (0 points)' };
  if (!isLongOption) return { points: 0, text, note: 'stock big-move: context only (not a long option)' };
  if (r.bucket === 'TOP20') return { points: 1, text, note: 'stock big-move TOP20: can outrun theta (+1)' };
  if (r.bucket === 'BOTTOM20') return { points: -1, text, note: 'stock big-move BOTTOM20: theta dominates (−1)' };
  return { points: 0, text, note: 'stock big-move MID: no vote' };
}
