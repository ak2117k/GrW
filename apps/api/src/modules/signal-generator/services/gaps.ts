import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * Minimal candle shape for gap detection — only high/low are needed.
 * Candles are expected oldest→newest. Pure function, no IO.
 */
export interface GapCandle {
  high: number;
  low: number;
}

/** Most-recent unfilled gaps to keep. */
const MAX_GAPS = 3;
const GAP_MAX_SCORE = 20;

/**
 * Unfilled-gap S/R levels (kind 'GAP', score 0–20).
 *
 * Detects price gaps between consecutive bars:
 *  - gap UP   : candle[i].low  > candle[i-1].high  → gap edge = prior high (acts as support)
 *  - gap DOWN : candle[i].high < candle[i-1].low   → gap edge = prior low  (acts as resistance)
 *
 * A gap is "unfilled" when no LATER bar has traded back through its edge:
 *  - gap up   stays unfilled while every later bar's low  stays  above the edge
 *  - gap down stays unfilled while every later bar's high stays  below the edge
 * (a bar reaching exactly the edge counts as a fill — the level was tested.)
 *
 * Score scales with gap size (as a % of the edge price) and recency: a bigger,
 * fresher gap is a stronger magnet. Capped at the {@link MAX_GAPS} most-recent
 * unfilled gaps. A gap edge sitting on the live price is skipped.
 *
 * Returns [] for fewer than 2 candles.
 */
export function gapLevels(candles: GapCandle[], ltp: number): LevelCandidate[] {
  const out: LevelCandidate[] = [];
  if (!Array.isArray(candles) || candles.length < 2) return out;

  const n = candles.length;
  // Walk newest→oldest so the freshest gaps win the MAX_GAPS budget; recency
  // weight = how close the gap is to the latest bar.
  for (let i = n - 1; i >= 1 && out.length < MAX_GAPS; i--) {
    const prev = candles[i - 1];
    const cur = candles[i];

    let edge: number | null = null;
    let size = 0;
    let filled = false;

    if (cur.low > prev.high) {
      // Gap up: edge is the prior high (support below current action).
      edge = prev.high;
      size = cur.low - prev.high;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].low <= edge) { filled = true; break; }
      }
    } else if (cur.high < prev.low) {
      // Gap down: edge is the prior low (resistance above current action).
      edge = prev.low;
      size = prev.low - cur.high;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].high >= edge) { filled = true; break; }
      }
    }

    if (edge === null || filled || !(edge > 0)) continue;
    if (Math.abs(edge - ltp) <= 1e-6 * Math.max(1, Math.abs(ltp))) continue;

    const sizePct = size / edge;                  // fractional gap size
    const recency = (i + 1) / n;                  // newer bar → closer to 1
    // ~2% gap saturates the size component; recency scales it down for old gaps.
    const score = Math.min(GAP_MAX_SCORE, GAP_MAX_SCORE * Math.min(sizePct / 0.02, 1) * recency);

    out.push({ price: edge, kind: 'GAP', score });
  }
  return out;
}
