import { computeAtrFromCandles } from '../services/per-tf-atr';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import { CHART_SWING_STRENGTH } from '../patterns/chart-patterns';
import { resolveFollowThrough } from './follow-through';
import {
  DEFAULT_FT_PARAMS,
  type FollowThroughParams,
  type OhlcvCandle,
  type PatternObservationInput,
} from './pattern-observation.types';

/**
 * Bars between a CHART pattern's anchor and the first bar at which it is
 * DETECTABLE — i.e. the point-in-time skew this module has to correct for.
 *
 * A chart pattern's anchor is its second peak/trough, a swing pivot. `swingHighs`
 * /`swingLows` require `CHART_SWING_STRENGTH` bars on BOTH sides of a pivot, so a
 * pivot at index `i` only becomes a pivot once bar `i + CHART_SWING_STRENGTH`
 * closes. Live, `/patterns` therefore cannot surface a CHART marker any earlier
 * than that. Labelling such a pattern from its anchor would price the entry at a
 * bar the trader could not have acted on and would let bars `anchor+1 … anchor+lag`
 * count toward the k×ATR move even though they were spent DETECTING the pattern —
 * a systematically optimistic label. See docs/learning/ml/02-features-and-the-atr-
 * follow-through-label.md ("never let anything cross the anchor line").
 *
 * Aliased to the detector's own constant on purpose: if the two ever drifted apart
 * the skew would silently return, so there is exactly one number to change.
 */
export const CHART_DETECTION_LAG_BARS = CHART_SWING_STRENGTH;

export interface AssembleOpts {
  /** bars of history stored as the feature window (incl. anchor). Default 50. */
  windowBars?: number;
  /** ATR period. Default 14. */
  atrPeriod?: number;
  params?: FollowThroughParams;
}

export interface ObservationMeta {
  token: string;
  exchange: string;
  timeframe: string;
}

/**
 * Turn detector markers into persistable observations. For each non-neutral
 * marker we locate its anchor candle, derive the DECISION bar (the first bar at
 * which the pattern is actually detectable — the anchor for CANDLESTICK, anchor +
 * {@link CHART_DETECTION_LAG_BARS} for CHART), then slice the feature window,
 * compute ATR, and resolve the ATR-follow-through outcome all from that decision
 * bar. Everything representing "what you knew / could do at decision time" keys
 * off it.
 *
 * `barTime` is the exception: it stays the marker's own anchor. It is the
 * pattern's identity and part of the unique key
 * (token, exchange, timeframe, patternName, barTime) — only the label/feature
 * computation shifts, never the row's identity.
 *
 * NEUTRAL patterns are skipped (no direction to follow). Markers whose `time`
 * doesn't match a candle are dropped, as are CHART markers whose decision bar
 * lies beyond the series (not yet knowable). Pure — deterministic given inputs.
 */
export function buildObservationInputs(
  candles: OhlcvCandle[],
  markers: PatternMarkerDto[],
  meta: ObservationMeta,
  opts: AssembleOpts = {},
): PatternObservationInput[] {
  const windowBars = opts.windowBars ?? 50;
  const atrPeriod = opts.atrPeriod ?? 14;
  const params = opts.params ?? DEFAULT_FT_PARAMS;

  const indexByTime = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

  const out: PatternObservationInput[] = [];
  for (const marker of markers) {
    if (marker.bias !== 'BULLISH' && marker.bias !== 'BEARISH') continue;
    const anchor = indexByTime.get(marker.time);
    if (anchor === undefined) continue;

    // The bar we could actually have ACTED on. CANDLESTICK patterns are 1-3 bar
    // shapes ending at their anchor, so they are knowable at that bar's close and
    // shift by 0. CHART patterns pivot on a swing point and need `lag` more bars
    // to be recognised at all.
    const lag = marker.category === 'CHART' ? CHART_DETECTION_LAG_BARS : 0;
    const decisionIndex = anchor + lag;
    // Pattern isn't knowable yet within this series — and there's no bar to price
    // the entry from. Drop it rather than label it from a bar that doesn't exist.
    if (decisionIndex >= candles.length) continue;

    const dir: 1 | -1 = marker.bias === 'BULLISH' ? 1 : -1;
    const atr = computeAtrFromCandles(candles.slice(0, decisionIndex + 1), atrPeriod);
    if (atr <= 0) continue; // can't scale a follow-through target without ATR

    // Full candle array — the LABEL may legitimately read future bars; only the
    // decision point shifts. Entry = close at `decisionIndex`, scan starts after it.
    const ft = resolveFollowThrough(candles, decisionIndex, dir, atr, params);
    const window = candles.slice(Math.max(0, decisionIndex - windowBars + 1), decisionIndex + 1);

    out.push({
      token: meta.token,
      exchange: meta.exchange,
      timeframe: meta.timeframe,
      patternName: marker.name,
      category: marker.category,
      bias: marker.bias,
      barTime: new Date(marker.time),
      candleWindow: window,
      atrAtDetection: atr,
      outcome: ft.outcome,
      label: ft.label,
    });
  }
  return out;
}
