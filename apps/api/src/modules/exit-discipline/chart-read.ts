/**
 * CHART CONFIRMATION FOR LOSS-SIDE EXITS (2026-11-19, owner). Pure.
 *
 * Owner: "it should only go for the SL side when the other factors are against when we do the graph reading."
 * Prod 2026-11-19 BANKNIFTY 62300 CE: the AI said HOLD four times ("underlying 0.7 N against, still above the
 * 62359 ORH support, 3m/15m BULLISH_CONFIRMED"); 14 s later FLOOR_HARD_EXIT GREEN_TO_RED sold it at 392.9 on a
 * premium dip; it went to 768. PAYTM 1780 CE: ₹2,000 MAX_LOSS sold 2.5 min after entry with PAYTM above the
 * AI's invalidation and VWAP. Over three weeks MAX_LOSS exits missed more (₹54k) than they saved (₹39k).
 *
 * The chart is AGAINST the position when ANY of these holds on the UNDERLYING (never the option premium):
 *   1. the last CLOSED 5-minute or 15-minute bar closed beyond the thesis invalidation;
 *   2. the underlying has moved >= K15 x N15 against from the position's best point (N15 = ATR14 of 15-minute
 *      session bars — the 1-minute N is an ordinary minute's swing, the wrong yardstick for "the trade is wrong");
 *   3. the 15-minute Supertrend (10, 3) on closed bars points against the position.
 * Not enough data to read any of them => `known: false`, which the gate treats as AGAINST (today's exit stands).
 */
export type ChartBar = { ts: number; open: number; high: number; low: number; close: number; volume?: number | null };

export interface ChartReadInput {
  /** The position profits when the underlying rises. */
  bull: boolean;
  underlyingNow: number | null;
  invalidation: number | null;
  bestUnderlying: number | null;
  /** CLOSED bars, ascending. */
  bars5: readonly ChartBar[];
  bars15: readonly ChartBar[];
  n15: number | null;
  k15: number;
}

export type ChartRead = {
  v: 1;
  /** At least one test could be measured. */
  known: boolean;
  against: boolean;
  reasons: string[];
  measured: {
    close5: number | null; close15: number | null; invalidation: number | null;
    adverseFromBest: number | null; n15: number | null; needPts: number | null;
    supertrend15: 'UP' | 'DOWN' | null; supertrendLine15: number | null;
  };
};

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
/** An invalidation further than this from the underlying is on the wrong scale (a premium, a typo): not used. */
const INVALIDATION_SCALE = 0.1;

/** Supertrend direction and line on the last bar (ATR = Wilder RMA). Null with fewer than period + 1 bars. */
export function supertrend(bars: readonly ChartBar[], period = 10, mult = 3): { dir: 'UP' | 'DOWN'; line: number } | null {
  const b = bars.filter((x) => [x.high, x.low, x.close].every(fin) && x.high >= x.low);
  if (b.length < period + 1) return null;
  let atr = 0;
  let upper = 0, lower = 0, dir: 'UP' | 'DOWN' = 'UP';
  for (let i = 0; i < b.length; i++) {
    const tr = i === 0 ? b[i].high - b[i].low
      : Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    atr = i < period ? (atr * i + tr) / (i + 1) : (atr * (period - 1) + tr) / period;
    const mid = (b[i].high + b[i].low) / 2;
    const bu = mid + mult * atr;
    const bl = mid - mult * atr;
    if (i === 0) {
      upper = bu; lower = bl; dir = 'UP';
      continue;
    }
    const prevClose = b[i - 1].close;
    upper = bu < upper || prevClose > upper ? bu : upper;
    lower = bl > lower || prevClose < lower ? bl : lower;
    if (dir === 'UP' && b[i].close < lower) dir = 'DOWN';
    else if (dir === 'DOWN' && b[i].close > upper) dir = 'UP';
  }
  return { dir, line: r2(dir === 'UP' ? lower : upper) };
}

export function readChart(i: ChartReadInput): ChartRead {
  const reasons: string[] = [];
  let measuredAny = false;
  let against = false;
  const last5 = i.bars5.length ? i.bars5[i.bars5.length - 1].close : null;
  const last15 = i.bars15.length ? i.bars15[i.bars15.length - 1].close : null;
  const beyond = (x: number, lvl: number) => (i.bull ? x < lvl : x > lvl);

  // 1. a closed 5m / 15m bar beyond the thesis invalidation
  const ref = fin(i.underlyingNow) ? i.underlyingNow : fin(last5) ? last5 : null;
  const inv = fin(i.invalidation) && ref !== null && Math.abs(i.invalidation - ref) / ref <= INVALIDATION_SCALE ? i.invalidation : null;
  if (inv !== null && (fin(last5) || fin(last15))) {
    measuredAny = true;
    const hit = [last5, last15].filter(fin).filter((c) => beyond(c, inv));
    if (hit.length) {
      against = true;
      reasons.push(`a closed ${fin(last5) && beyond(last5, inv) ? '5m' : '15m'} bar closed beyond the invalidation ${inv}`);
    }
  }

  // 2. >= K15 x N15 against from the best point
  let adverse: number | null = null;
  let need: number | null = null;
  if (fin(i.bestUnderlying) && fin(i.underlyingNow) && fin(i.n15) && i.n15 > 0) {
    measuredAny = true;
    adverse = r2(i.bull ? i.bestUnderlying - i.underlyingNow : i.underlyingNow - i.bestUnderlying);
    need = r2(i.k15 * i.n15);
    if (adverse >= need - 1e-9) {
      against = true;
      reasons.push(`underlying ${adverse} pts against from its best (>= ${i.k15} x N15 ${i.n15} = ${need})`);
    }
  }

  // 3. the 15-minute Supertrend
  const st = supertrend(i.bars15);
  if (st) {
    measuredAny = true;
    if ((i.bull && st.dir === 'DOWN') || (!i.bull && st.dir === 'UP')) {
      against = true;
      reasons.push(`15m Supertrend is ${st.dir} (line ${st.line})`);
    }
  }

  if (!measuredAny) reasons.push('chart not readable (no bars / no N15 / no invalidation) — treated as against');
  else if (!against) reasons.push('chart intact: no closed bar beyond the invalidation, move against below K15 x N15, 15m Supertrend with the position');

  return {
    v: 1,
    known: measuredAny,
    against: against || !measuredAny,
    reasons,
    measured: {
      close5: last5, close15: last15, invalidation: inv, adverseFromBest: adverse, n15: fin(i.n15) ? i.n15 : null, needPts: need,
      supertrend15: st?.dir ?? null, supertrendLine15: st?.line ?? null,
    },
  };
}

/** EXIT_CHART_CONFIRM: off | observe (default: record what it would hold) | act (hold). */
export type ChartConfirmMode = 'off' | 'observe' | 'act';
export function chartConfirmMode(env: Record<string, string | undefined> = process.env): ChartConfirmMode {
  const v = String(env.EXIT_CHART_CONFIRM ?? '').trim().toLowerCase();
  return v === 'off' || v === 'act' ? v : 'observe';
}

/**
 * PROFIT_CHART_CONFIRM: off | observe (default) | act — the same chart check on PROFIT-side code exits
 * (FLOOR_HARD_GREEN_LOCK, FLOOR_HARD_UNDERLYING_MOVE, the TARGET_LADDER trail). Owner 2026-11-20, LTM 4100 CE:
 * bought 85, the AI said HOLD every look, the green lock sold 139.55 on a 12.7-pt LTM dip (1.0 x its 1-MINUTE N,
 * 0.18 x N15) with the chart intact; the stock kept rising. Replay of 33 live profit-side exits (21 days): holding
 * while the chart is intact netted +₹6.9k but was worse on 18 of 29 (the floor was right on most; the gain is a few
 * trend days) — so it starts in OBSERVE.
 */
export function profitChartConfirmMode(env: Record<string, string | undefined> = process.env): ChartConfirmMode {
  const v = String(env.PROFIT_CHART_CONFIRM ?? '').trim().toLowerCase();
  return v === 'off' || v === 'act' ? v : 'observe';
}

/** HARD_LOSS_ABS_RUPEES (owner 2026-11-19: ₹3,500): the loss that exits whatever the chart says. Junk/unset => 3500. */
export const HARD_LOSS_ABS_DEFAULT = 3500;
export function hardLossAbsRupees(env: Record<string, string | undefined> = process.env): number {
  const n = Number(String(env.HARD_LOSS_ABS_RUPEES ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : HARD_LOSS_ABS_DEFAULT;
}
