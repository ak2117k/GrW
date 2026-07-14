import { computeAtrFromCandles } from '../services/per-tf-atr';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import { resolveFollowThrough } from './follow-through';
import {
  DEFAULT_FT_PARAMS,
  type FollowThroughParams,
  type OhlcvCandle,
  type PatternObservationInput,
} from './pattern-observation.types';

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
 * marker we locate its anchor candle, slice the feature window, compute ATR at
 * the anchor, and resolve the ATR-follow-through outcome. NEUTRAL patterns are
 * skipped (no direction to follow). Markers whose `time` doesn't match a candle
 * are dropped. Pure — deterministic given inputs.
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

    const dir: 1 | -1 = marker.bias === 'BULLISH' ? 1 : -1;
    const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), atrPeriod);
    if (atr <= 0) continue; // can't scale a follow-through target without ATR

    const ft = resolveFollowThrough(candles, anchor, dir, atr, params);
    const window = candles.slice(Math.max(0, anchor - windowBars + 1), anchor + 1);

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
