import { resolveFollowThrough } from '../ml/follow-through';
import type { OhlcvCandle } from '../ml/pattern-observation.types';

/**
 * Measures how accurate the S/R levels actually are, from historical candles.
 *
 * Two different questions, deliberately reported separately, because a level
 * can be excellent at one and useless at the other:
 *
 *  1. HOLD RATE — price reached the level and turned away. This is what a
 *     reversal trader is buying.
 *  2. FOLLOW-THROUGH RATE — price broke the level and then travelled to the
 *     projected target before hitting the stop. This is what the projection
 *     boxes claim, and it is the number that belongs on them.
 *
 * A level with a 70% hold rate and a 30% follow-through rate is a good fade and
 * a bad breakout. Averaging the two into one "accuracy" figure would hide
 * exactly the distinction a trader needs, so this never does that.
 *
 * Pure: no IO, no clock, no DI. Feed it candles, get a report.
 */

export interface BacktestCandle extends OhlcvCandle {
  /** Unix seconds. */
  time: number;
}

export type LevelKind = 'PDH' | 'PDL' | 'ROUND' | 'VWAP';

export interface KindStats {
  /** Times price came within tolerance of a level of this kind. */
  tested: number;
  /** Of those, times it turned away without closing through. */
  held: number;
  /** Of those, times it closed decisively through. */
  broke: number;
  /** held / tested, or null when the sample is empty — never a fabricated 0. */
  holdRate: number | null;
}

export interface FollowThroughStats {
  breaks: number;
  reachedTarget: number;
  hitStop: number;
  timedOut: number;
  /** reachedTarget / resolved, or null when nothing resolved. */
  rate: number | null;
}

export interface SrBacktestReport {
  timeframe: string;
  candles: number;
  byKind: Record<LevelKind, KindStats>;
  followThrough: Record<LevelKind, FollowThroughStats>;
  /** Every kind pooled — the headline number, still reported with its sample. */
  overall: FollowThroughStats;
}

export interface SrBacktestOptions {
  timeframe: string;
  /** Bars per session, used to bracket the prior day for PDH/PDL. */
  barsPerSession: number;
  /** How close counts as "tested", in ATR. */
  touchAtr?: number;
  /** Body beyond the level that counts as a break, in ATR. Matches the engine. */
  breakBodyAtr?: number;
  /** Forward bars allowed for the move to resolve. */
  horizonBars?: number;
  /** Target distance in ATR — the projection's own reward leg. */
  targetAtr?: number;
  /** Stop distance in ATR — the projection's own risk leg. */
  stopAtr?: number;
}

/** Engine defaults, so the backtest measures what the chart actually claims. */
const DEFAULTS = {
  touchAtr: 0.15,
  breakBodyAtr: 0.5,
  horizonBars: 16,
  targetAtr: 1.5,
  stopAtr: 1.0,
};

const KINDS: LevelKind[] = ['PDH', 'PDL', 'ROUND', 'VWAP'];

function emptyKindStats(): KindStats {
  return { tested: 0, held: 0, broke: 0, holdRate: null };
}

function emptyFollowThrough(): FollowThroughStats {
  return { breaks: 0, reachedTarget: 0, hitStop: 0, timedOut: 0, rate: null };
}

/** Wilder ATR over the whole series, one value per bar (null until warm). */
function atrSeries(candles: BacktestCandle[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(candles.length).fill(null);
  let prevClose = candles[0]?.close;
  let sum = 0;
  let atr: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - (prevClose ?? c.close)),
      Math.abs(c.low - (prevClose ?? c.close)),
    );
    prevClose = c.close;
    if (i < period) {
      sum += tr;
      if (i === period - 1) {
        atr = sum / period;
        out[i] = atr;
      }
      continue;
    }
    atr = ((atr as number) * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

/** Round levels on the same adaptive grid the engine uses: a step near 0.5%. */
function roundLevelsNear(price: number): number[] {
  if (!(price > 0)) return [];
  const raw = price * 0.005;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(mag, 1);
  const base = Math.round(price / step) * step;
  return [base - step, base, base + step].filter((v) => v > 0);
}

/**
 * Levels in force at bar `i`.
 *
 * PDH/PDL come from the previous session's bracket rather than a rolling window,
 * because that is what the engine anchors on — a rolling high would measure a
 * different thing and quietly flatter the result.
 */
function levelsAt(
  candles: BacktestCandle[],
  i: number,
  barsPerSession: number,
): Array<{ kind: LevelKind; price: number }> {
  const out: Array<{ kind: LevelKind; price: number }> = [];
  const sessionIndex = Math.floor(i / barsPerSession);
  if (sessionIndex >= 1) {
    const from = (sessionIndex - 1) * barsPerSession;
    const to = sessionIndex * barsPerSession;
    const prior = candles.slice(from, to);
    if (prior.length > 0) {
      out.push({ kind: 'PDH', price: Math.max(...prior.map((c) => c.high)) });
      out.push({ kind: 'PDL', price: Math.min(...prior.map((c) => c.low)) });
    }
  }

  // Session VWAP to date.
  const sessionStart = sessionIndex * barsPerSession;
  let pv = 0;
  let vv = 0;
  for (let j = sessionStart; j <= i; j++) {
    const c = candles[j];
    const typical = (c.high + c.low + c.close) / 3;
    const vol = Number(c.volume) || 0;
    pv += typical * vol;
    vv += vol;
  }
  if (vv > 0) out.push({ kind: 'VWAP', price: pv / vv });

  for (const r of roundLevelsNear(candles[i].close)) out.push({ kind: 'ROUND', price: r });
  return out;
}

/**
 * Replay the series and score every level interaction.
 *
 * A level is counted ONCE per interaction, not once per bar: price loitering at
 * a level for six bars is one test, not six, and counting bars would inflate
 * whichever outcome happened to be slower.
 */
export function backtestSrLevels(
  candles: BacktestCandle[],
  opts: SrBacktestOptions,
): SrBacktestReport {
  const o = { ...DEFAULTS, ...opts };
  const byKind = Object.fromEntries(KINDS.map((k) => [k, emptyKindStats()])) as Record<
    LevelKind,
    KindStats
  >;
  const followThrough = Object.fromEntries(
    KINDS.map((k) => [k, emptyFollowThrough()]),
  ) as Record<LevelKind, FollowThroughStats>;

  if (!Array.isArray(candles) || candles.length < 30) {
    return {
      timeframe: o.timeframe,
      candles: candles?.length ?? 0,
      byKind,
      followThrough,
      overall: emptyFollowThrough(),
    };
  }

  const atr = atrSeries(candles);
  /**
   * Levels currently being interacted with.
   *
   * An interaction starts when price first reaches the level and ends only when
   * price LEAVES it — not after a fixed number of bars. Price parking against a
   * level for eighty bars is one test, not sixteen; counting windows inflated
   * whichever outcome happened to be slower, which is precisely the bias a
   * backtest exists to avoid.
   */
  const active = new Set<string>();

  for (let i = 14; i < candles.length - 1; i++) {
    const a = atr[i];
    if (a === null || !(a > 0)) continue;
    const c = candles[i];
    const tol = o.touchAtr * a;
    const body = Math.abs(c.close - c.open);

    for (const lvl of levelsAt(candles, i, o.barsPerSession)) {
      if (!(lvl.price > 0)) continue;
      const key = `${lvl.kind}:${lvl.price.toFixed(2)}`;
      const touched = c.high >= lvl.price - tol && c.low <= lvl.price + tol;

      if (!touched) {
        // Price has cleared the level by a full ATR — the interaction is over
        // and the next approach counts as a new one.
        if (Math.abs(c.close - lvl.price) > a) active.delete(key);
        continue;
      }
      if (active.has(key)) continue;
      active.add(key);

      byKind[lvl.kind].tested++;

      const brokeUp = c.close > lvl.price && body > o.breakBodyAtr * a;
      const brokeDown = c.close < lvl.price && body > o.breakBodyAtr * a;
      if (!brokeUp && !brokeDown) {
        byKind[lvl.kind].held++;
        continue;
      }

      byKind[lvl.kind].broke++;

      // Did the break actually go anywhere? Same labeller the ML pipeline uses,
      // so a backtested rate and a live-captured one mean the same thing.
      const ft = resolveFollowThrough(candles, i, brokeUp ? 1 : -1, a, {
        k: o.targetAtr,
        m: o.stopAtr,
        n: o.horizonBars,
      });
      const stats = followThrough[lvl.kind];
      stats.breaks++;
      if (ft.outcome === 'WIN') stats.reachedTarget++;
      else if (ft.outcome === 'LOSS') stats.hitStop++;
      else if (ft.outcome === 'TIMEOUT') stats.timedOut++;
    }
  }

  for (const k of KINDS) {
    const s = byKind[k];
    s.holdRate = s.tested > 0 ? s.held / s.tested : null;
    const f = followThrough[k];
    const resolved = f.reachedTarget + f.hitStop + f.timedOut;
    f.rate = resolved > 0 ? f.reachedTarget / resolved : null;
  }

  const overall = emptyFollowThrough();
  for (const k of KINDS) {
    overall.breaks += followThrough[k].breaks;
    overall.reachedTarget += followThrough[k].reachedTarget;
    overall.hitStop += followThrough[k].hitStop;
    overall.timedOut += followThrough[k].timedOut;
  }
  const resolvedAll = overall.reachedTarget + overall.hitStop + overall.timedOut;
  overall.rate = resolvedAll > 0 ? overall.reachedTarget / resolvedAll : null;

  return { timeframe: o.timeframe, candles: candles.length, byKind, followThrough, overall };
}
