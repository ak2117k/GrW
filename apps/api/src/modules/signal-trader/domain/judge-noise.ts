import { noiseFromBars } from '../../exit-discipline/noise';
import type { MinuteBar } from '../../exit-discipline/types';
import { capSizedStop, validStop } from './fair-score';
import type { DeltaReading } from './option-delta';

/**
 * The entry judge's numbers for "is this stop inside noise?", "is this quote stale?" and "is this
 * channel's record evidence?" (owner 2026-11-02, after the judge guessed all three on NIFTY 23000 CE). Pure.
 *
 * NOISE: the underlying's 1-minute noise unit N1 (exit-discipline noiseFromBars: ATR14 of 1-min bars,
 * else range/√bars) and 5-minute N5 (ATR14 of 5-min buckets of the same 1-min bars, else N1·√5), the
 * contract's own premium N1 when its bars exist, and for the plan's SL and the CAP-SIZED SL (the widest
 * stop that keeps 1 lot ≤ caps.maxLossPerTrade — domain/fair-score) the distance from the price in
 * premium points, the underlying move that reaches it (premium points / |delta|) and that move in N1 / N5.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export interface UnderlyingNoise {
  n1: number | null;
  n1Method: string | null;
  n5: number | null;
  n5Method: string | null;
  bars: number;
}

const FIVE_MIN = 5 * 60_000;
const ATR_N = 14;

/** ATR14 of 5-minute buckets (aligned to the clock: 09:15 IST is a 5-min boundary), else N1 × √5. */
export function underlyingNoise(input: readonly MinuteBar[]): UnderlyingNoise {
  const bars = input.filter((b) => [b.ts, b.high, b.low, b.close].every(fin) && b.low > 0 && b.high >= b.low).sort((a, b) => a.ts - b.ts);
  const one = noiseFromBars(bars as MinuteBar[]);
  const buckets: Array<{ high: number; low: number; close: number }> = [];
  let key = -1;
  for (const b of bars) {
    const k = Math.floor(b.ts / FIVE_MIN);
    if (k !== key) {
      buckets.push({ high: b.high, low: b.low, close: b.close });
      key = k;
    } else {
      const c = buckets[buckets.length - 1];
      c.high = Math.max(c.high, b.high);
      c.low = Math.min(c.low, b.low);
      c.close = b.close;
    }
  }
  let n5: number | null = null;
  let n5Method: string | null = null;
  if (buckets.length >= ATR_N + 1) {
    const tr = buckets.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - buckets[i - 1].close), Math.abs(b.low - buckets[i - 1].close))));
    const last = tr.slice(-ATR_N);
    const v = last.reduce((s, x) => s + x, 0) / ATR_N;
    if (v > 0) {
      n5 = r2(v);
      n5Method = 'atr14-5m (5-min buckets of the 1-min bars)';
    }
  }
  if (n5 === null && one) {
    n5 = r2(one.n * Math.sqrt(5));
    n5Method = `${one.method} × √5`;
  }
  return { n1: one ? r2(one.n) : null, n1Method: one?.method ?? null, n5, n5Method, bars: bars.length };
}

export interface StopDistance {
  stop: number;
  /** |price − stop| in the contract's own points. */
  premiumPts: number;
  /** The underlying move that reaches it: premiumPts / |delta| (1:1 for a future / cash line). */
  underlyingPts: number | null;
  inN1: number | null;
  inN5: number | null;
  /** premiumPts in the contract's own 1-min noise unit, when its bars exist. */
  inPremiumN1: number | null;
}

export function stopDistance(i: { price: number; stop: number | null; absDelta: number | null; n1: number | null; n5: number | null; premiumN1: number | null }): StopDistance | null {
  if (i.stop === null || !(i.price > 0)) return null;
  const premiumPts = r2(Math.abs(i.price - i.stop));
  const u = i.absDelta !== null && i.absDelta > 0 ? r2(premiumPts / i.absDelta) : null;
  const per = (x: number | null, n: number | null) => (x !== null && n !== null && n > 0 ? r2(x / n) : null);
  return { stop: i.stop, premiumPts, underlyingPts: u, inN1: per(u, i.n1), inN5: per(u, i.n5), inPremiumN1: per(premiumPts, i.premiumN1) };
}

export interface NoiseBlockValue {
  underlying: UnderlyingNoise & { symbol: string | null; source: string };
  premium: { n1: number; method: string; bars: number } | null;
  delta: DeltaReading | null;
  stops: { plan: StopDistance | null; cap: StopDistance | null };
  capStopRule: string;
  read: string;
}

const fmtStop = (label: string, d: StopDistance | null): string | null => {
  if (!d) return null;
  const u = d.underlyingPts !== null ? ` ≈ ${d.underlyingPts} underlying pts` : '';
  const n = d.inN5 !== null ? ` = ${d.inN5}×N5 (${d.inN1 ?? '?'}×N1)` : '';
  return `${label} ${d.stop}: ${d.premiumPts} premium pts${u}${n}`;
};

/** market.noise: the block itself (the service does the reads). */
export function noiseBlock(i: {
  side: string;
  price: number;
  planSl: number | null;
  cap: number | null;
  lotQty: number;
  tick: number;
  delta: DeltaReading | null;
  underlying: UnderlyingNoise & { symbol: string | null; source: string };
  premium: { n1: number; method: string; bars: number } | null;
}): NoiseBlockValue {
  const plan = validStop(i.side, i.price, i.planSl);
  const cap = capSizedStop({ side: i.side, entry: i.price, cap: i.cap, lotQty: i.lotQty, signalSl: i.planSl, tick: i.tick });
  const d = i.delta?.abs ?? null;
  const args = { price: i.price, absDelta: d, n1: i.underlying.n1, n5: i.underlying.n5, premiumN1: i.premium?.n1 ?? null };
  const planD = stopDistance({ ...args, stop: plan });
  const capD = cap !== null && cap !== plan ? stopDistance({ ...args, stop: cap }) : cap !== null ? planD : null;
  const units = i.underlying.n1 !== null ? `N1 ${i.underlying.n1} / N5 ${i.underlying.n5 ?? '?'} underlying pts` : 'underlying noise unknown';
  const read = [units, fmtStop('plan SL', planD), fmtStop('cap-sized SL', capD), i.delta ? `|delta| ${i.delta.abs} (${i.delta.source.split(' (')[0]})` : 'delta unknown']
    .filter(Boolean)
    .join('; ');
  return {
    underlying: i.underlying,
    premium: i.premium,
    delta: i.delta,
    stops: { plan: planD, cap: capD },
    capStopRule: `the widest stop keeping 1 lot (${i.lotQty}) within caps.maxLossPerTrade ₹${i.cap ?? '?'}: price ${String(i.side).toUpperCase() === 'SELL' ? '+' : '−'} cap / lot qty, never wider than the plan SL`,
    read,
  };
}

/**
 * plan.optionValue: an option's intrinsic value from the SPOT (the cash index / the stock), never the
 * future (the future carries cost of carry; options settle to spot). `belowIntrinsicPct` > 0 = the
 * quote is under spot intrinsic by that % of intrinsic — up to ~1 % near expiry is normal (the bid/ask
 * of a deep-ITM strike, no carry for its buyer), not a stale quote.
 */
export const NORMAL_BELOW_INTRINSIC_PCT = 1;
export function optionValue(i: { kind: string; strike: number | null; ltp: number; spot: number | null; spotSource: string | null; future: number | null; daysToExpiry: number | null }): Record<string, unknown> | null {
  if ((i.kind !== 'CE' && i.kind !== 'PE') || i.strike === null || i.spot === null || !(i.spot > 0) || !(i.ltp > 0)) return null;
  const intrinsic = r2(Math.max(0, i.kind === 'CE' ? i.spot - i.strike : i.strike - i.spot));
  const timeValue = r2(i.ltp - intrinsic);
  const below = intrinsic > 0 && i.ltp < intrinsic ? r2(((intrinsic - i.ltp) / intrinsic) * 100) : 0;
  const normal = below <= NORMAL_BELOW_INTRINSIC_PCT;
  const read =
    intrinsic === 0
      ? `out of the money: all ${i.ltp} is time value`
      : below > 0
        ? `quote ${i.ltp} is ${below}% below spot intrinsic ${intrinsic}${normal ? ' — normal for a deep-ITM option near expiry (bid/ask, no carry), NOT a stale quote' : ' — more than 1% under intrinsic: check liquidity'}`
        : `intrinsic ${intrinsic} (from spot) + time value ${timeValue}`;
  return {
    strike: i.strike,
    kind: i.kind,
    spot: i.spot,
    spotIs: `the underlying's SPOT (${i.spotSource ?? 'source unknown'}) — intrinsic is measured from this`,
    future: i.future,
    futureIs: i.future !== null ? 'the near-month FUTURE: includes cost of carry, NEVER use it for intrinsic' : null,
    intrinsicFromSpot: intrinsic,
    timeValue,
    belowIntrinsicPct: below,
    belowIntrinsicNormal: normal,
    daysToExpiry: i.daysToExpiry !== null ? r2(i.daysToExpiry) : null,
    read,
  };
}

/**
 * channelStats for the judge: the self-review's byChannel row plus how many calls are SCORED.
 * `n` / `right` / `wrong` are the LAST SESSION only (n counts every call, scored or not); the record that
 * matters is the rolling 20 sessions. Under {@link MIN_SCORED_CALLS} scored calls the record is noise:
 * sampleSufficient = false, and the prompt forbids citing it.
 */
export const MIN_SCORED_CALLS = 8;
export function channelStatsForJudge(stats: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!stats) return null;
  const n = (v: unknown) => (fin(v) ? v : 0);
  const sessionScored = n(stats.right) + n(stats.wrong);
  const has20 = fin(stats.rolling20Right) || fin(stats.rolling20Wrong);
  const scoredCalls = has20 ? n(stats.rolling20Right) + n(stats.rolling20Wrong) : sessionScored;
  const sampleSufficient = scoredCalls >= MIN_SCORED_CALLS;
  return {
    ...stats,
    sessionScored,
    scoredCalls,
    scoredCallsBasis: has20 ? 'rolling 20 sessions (rolling20Right + rolling20Wrong)' : 'last session (right + wrong)',
    sampleSufficient,
    read: `${scoredCalls} scored direct calls${has20 ? ' over 20 sessions' : ''}${sampleSufficient ? '' : ` — under ${MIN_SCORED_CALLS}: NOT evidence, do not cite the channel's record`}; n / right / wrong are the last session only (n = all calls seen, scored or not)`,
  };
}

type Block = { status: 'present'; source: string; value: unknown } | { status: 'unavailable' | 'not_applicable'; reason: string };
const val = (b: Block | undefined): Record<string, unknown> =>
  b && b.status === 'present' && b.value && typeof b.value === 'object' && !Array.isArray(b.value) ? (b.value as Record<string, unknown>) : {};

/** The spot / future / VIX the packet's market blocks already hold (the structure's spot ladder first, then the chain's). */
export function packetMarketFacts(market: Record<string, Block>): { spot: number | null; spotSource: string | null; future: number | null; vix: number | null } {
  const st = val(market.structure);
  const ch = val(market.chain);
  const mk = val(market.market);
  const n = (v: unknown) => (fin(v) && v > 0 ? v : null);
  const stSpot = n(st.spot);
  const chSpot = n(ch.spot);
  const spot = stSpot ?? chSpot ?? n(mk.spot);
  const spotSource = stSpot !== null ? `structure spot (${typeof st.spotSource === 'string' && st.spotSource ? st.spotSource : 'ladder'})` : chSpot !== null ? 'chain snapshot spot' : spot !== null ? 'market-context feed spot' : null;
  return { spot, spotSource, future: n(ch.fut), vix: n(mk.vix) };
}

/** Labels the chain block's two prices in place, so the judge never reads the future as the spot. */
export function labelChain(market: Record<string, Block>): void {
  const ch = market.chain;
  if (!ch || ch.status !== 'present' || !ch.value || typeof ch.value !== 'object') return;
  const v = ch.value as Record<string, unknown>;
  v.spotIs = 'the cash INDEX / stock SPOT — options settle to it; intrinsic = spot − strike (CE) / strike − spot (PE)';
  if (v.fut !== null && v.fut !== undefined) v.futIs = 'the near-month FUTURE — spot + cost of carry; never use it for an option\'s intrinsic';
}
