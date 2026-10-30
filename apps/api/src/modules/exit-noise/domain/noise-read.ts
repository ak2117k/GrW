/**
 * "Noise or real?" — a RECORD-ONLY read taken at the moment an AI exit fires (owner 2026-10-30).
 * It never blocks, delays or changes the exit: the night review scores it against what the
 * underlying did next (noise-score.ts) before it could ever be a filter. Motivation (prod
 * 2026-10-30, SENSEX26N0574500CE paper): the AI's trigger "SENSEX BELOW 74459.1" fired on a dip to
 * 74458.33 at 11:25 IST while near-strike PUT OI was +3.1% (writers adding into the dip = support)
 * and CALL OI −0.5%; SENSEX then rallied 175 pts and the option to ~650 from the 531 exit.
 *
 * Five components, each optional (NO_DATA when its input is absent), each leaning NOISE / REAL /
 * NEUTRAL against the position's direction (`want`: what the position needs the underlying to do):
 *  1. MOVE    — the underlying's adverse move from the position's best point (money.anchors.best) in
 *               its 1-minute noise units: < {@link NOISE_READ.moveNoiseMaxN} N = NOISE, ≥
 *               {@link NOISE_READ.moveRealMinN} N = REAL.
 *  2. CHAIN   — near-money option OI over the last ~{@link NOISE_READ.windowMaxMin} min (oi-check's
 *               like-for-like strikes): lean = (ΔPE − ΔCE) / near-money total. For a bullish position,
 *               put writing / call unwinding (lean ≥ +{@link NOISE_READ.chainLeanMin}) = support =
 *               NOISE; call writing / put unwinding = REAL. Mirrored for a bearish position.
 *  3. FUTURES — the near-month future's OI with its price over the same window: price against the
 *               position + OI up = fresh positions against = REAL; price against + OI down =
 *               unwinding = NOISE. Price not against = NEUTRAL.
 *  4. VWAP    — the underlying still on the position's side of VWAP = NOISE; beyond it by ≥
 *               {@link NOISE_READ.vwapRealN} N = REAL.
 *  5. VOLUME  — the underlying's (or its future's) 1-minute volume over the dip vs the bars before:
 *               ≥ {@link NOISE_READ.volumeRealRatio}× = REAL, ≤ {@link NOISE_READ.volumeNoiseRatio}× = NOISE.
 * Verdict = the majority of the leaning components: more NOISE than REAL = NOISE, more REAL = REAL, a
 * tie (or every read component NEUTRAL) = MIXED, nothing read = NO_DATA. Pure; never throws.
 */
import { buckets, chainWindow, nearStrikes, type ChainContractRef, type OiRow } from '../../signal-trader/domain/oi-check';

export type NoiseVerdict = 'NOISE' | 'REAL' | 'MIXED' | 'NO_DATA';
export type NoiseLean = 'NOISE' | 'REAL' | 'NEUTRAL';
export type NoiseComponentName = 'MOVE' | 'CHAIN' | 'FUTURES' | 'VWAP' | 'VOLUME';
export type Want = 'BULLISH' | 'BEARISH';

/** The thresholds (config constants, documented in the module comment). */
export const NOISE_READ = Object.freeze({
  /** MOVE: < 2 N from the best point = NOISE; ≥ 3 N = REAL; between = NEUTRAL. */
  moveNoiseMaxN: 2,
  moveRealMinN: 3,
  /** OI windows: "now" = the latest usable snapshot ≤ the exit, at most this old. */
  nowMaxAgeMin: 6,
  /** "then" = the earliest usable snapshot at most this long before the exit … */
  windowMaxMin: 9,
  /** … and at least this long before "now". */
  windowMinGapMin: 2,
  /** A snapshot covering fewer than this share of the best-covered snapshot's near-money contracts is unusable. */
  minCoverage: 0.8,
  /** CHAIN: |(ΔPE − ΔCE) / total| ≥ 1% leans (a few minutes, so lower than oi-check's 2.5% over 30 min). */
  chainLeanMin: 0.01,
  /** FUTURES: |ΔOI| ≥ 0.5% of OI then, and the price ≥ 0.05% against. */
  futOiMin: 0.005,
  futPriceMin: 0.0005,
  /** A future's price is the one at an OI snapshot when it is at most this far from it. */
  priceToleranceMin: 3,
  /** VWAP: beyond VWAP on the wrong side by ≥ 0.5 N = REAL (sign only when N is unknown). */
  vwapRealN: 0.5,
  /** VWAP on the underlying's scale: more than 3% away from the underlying = a different scale, unused. */
  vwapMaxGapPct: 0.03,
  /** VOLUME: the last 5 one-minute bars vs the 20 before them (at least 10 with volume). */
  volumeDipBars: 5,
  volumeBaseBars: 20,
  volumeMinBaseBars: 10,
  volumeRealRatio: 1.5,
  volumeNoiseRatio: 0.8,
});

export interface NoiseReadInput {
  /** When the AI exit fired. */
  at: Date;
  want: Want;
  /** The underlying at the exit. */
  underlying: number | null;
  /** The underlying's 1-minute noise unit (packet flow.noiseUnit underlying N). */
  n: number | null;
  /** The underlying at the position's best point (money.anchors.best.underlying). */
  bestUnderlying: number | null;
  chain: { expiry: string; contracts: ChainContractRef[]; rows: OiRow[] } | null;
  futures: { symbol: string; instrumentId: string; rows: OiRow[]; prices: Array<{ at: Date; close: number }>; priceSource: string } | null;
  vwap: { value: number | null; source: string } | null;
  volume: { bars: Array<{ at: Date; volume: number }>; source: string } | null;
}

export interface NoiseComponent {
  name: NoiseComponentName;
  /** null = NO_DATA (the note says why). */
  lean: NoiseLean | null;
  /** One line: the numbers and why. */
  note: string;
  values?: Record<string, number | string | null>;
}

export interface NoiseRead {
  verdict: NoiseVerdict;
  want: Want;
  at: string;
  /** "NOISE 3–1 (move 1.4 N; chain PE +3.1% CE −0.5%; …)" — for the page / review. */
  summary: string;
  components: NoiseComponent[];
  error?: string;
}

const MIN = 60_000;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const pct = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const iso = (ms: number) => new Date(ms).toISOString();
const none = (name: NoiseComponentName, note: string): NoiseComponent => ({ name, lean: null, note });

/** + = the underlying moved AGAINST the position (from → now). */
function against(want: Want, from: number, now: number): number {
  return want === 'BULLISH' ? from - now : now - from;
}

export function moveComponent(i: Pick<NoiseReadInput, 'want' | 'underlying' | 'n' | 'bestUnderlying'>): NoiseComponent {
  if (!fin(i.bestUnderlying) || !(i.bestUnderlying > 0)) return none('MOVE', 'no underlying at the best point (money.anchors.best)');
  if (!fin(i.underlying) || !(i.underlying > 0)) return none('MOVE', 'no underlying price at the exit');
  if (!fin(i.n) || !(i.n > 0)) return none('MOVE', 'no underlying noise unit');
  const points = r2(against(i.want, i.bestUnderlying, i.underlying));
  const moveN = r2(points / i.n);
  const lean: NoiseLean = moveN < NOISE_READ.moveNoiseMaxN ? 'NOISE' : moveN >= NOISE_READ.moveRealMinN ? 'REAL' : 'NEUTRAL';
  return { name: 'MOVE', lean, note: `move ${moveN} N from the best (${points} pts, N ${r2(i.n)})`, values: { points, moveN, n: r2(i.n), best: i.bestUnderlying, now: i.underlying } };
}

/** now = latest usable ≤ at (≤ nowMaxAge old); then = earliest usable in [at − windowMax, now − minGap]. */
function shortWindow<T extends { at: number }>(usable: readonly T[], at: Date): { now: T | null; then: T | null; note?: string } {
  const t = at.getTime();
  const upTo = usable.filter((b) => b.at <= t);
  const now = upTo.length ? upTo[upTo.length - 1] : null;
  if (!now) return { now: null, then: null, note: 'no usable snapshot before the exit' };
  if (t - now.at > NOISE_READ.nowMaxAgeMin * MIN) return { now: null, then: null, note: `latest usable snapshot ${iso(now.at)} is older than ${NOISE_READ.nowMaxAgeMin} min` };
  const then = upTo.find((b) => b.at >= t - NOISE_READ.windowMaxMin * MIN && b.at <= now.at - NOISE_READ.windowMinGapMin * MIN) ?? null;
  return then ? { now, then } : { now, then: null, note: `no usable snapshot ${NOISE_READ.windowMinGapMin}–${NOISE_READ.windowMaxMin} min before the exit` };
}

export function chainComponent(i: Pick<NoiseReadInput, 'at' | 'want' | 'underlying' | 'chain'>): NoiseComponent {
  const c = i.chain;
  if (!c) return none('CHAIN', 'no option chain in oi_snapshots');
  if (!fin(i.underlying) || !(i.underlying > 0)) return none('CHAIN', 'no underlying price to centre the near-money strikes');
  const withData = new Set(c.rows.map((r) => r.instrumentId));
  const strikes = nearStrikes(c.contracts.filter((x) => withData.has(x.instrumentId)).map((x) => x.strike), i.underlying);
  if (strikes.length === 0) return none('CHAIN', `no option snapshots for ${c.expiry}`);
  const near = new Set(c.contracts.filter((x) => strikes.includes(x.strike)).map((x) => x.instrumentId));
  const all = buckets(c.rows, near);
  const best = Math.max(0, ...all.map((b) => b.oi.size));
  const w = shortWindow(all.filter((b) => b.oi.size >= best * NOISE_READ.minCoverage), i.at);
  if (!w.now || !w.then) return none('CHAIN', `${c.expiry}: ${w.note}`);
  const cw = chainWindow(w.then, w.now, new Map(c.contracts.map((x) => [x.instrumentId, x.optionType])));
  if (!cw) return none('CHAIN', `${c.expiry}: too few like-for-like contracts ${iso(w.then.at)} → ${iso(w.now.at)}`);
  // leanPct > 0 = bullish OI (put writing / call unwinding): support for a bullish position.
  const forPosition = i.want === 'BULLISH' ? cw.leanPct : -cw.leanPct;
  const lean: NoiseLean = forPosition >= NOISE_READ.chainLeanMin ? 'NOISE' : forPosition <= -NOISE_READ.chainLeanMin ? 'REAL' : 'NEUTRAL';
  return {
    name: 'CHAIN',
    lean,
    note: `chain ${c.expiry} ${strikes[0]}–${strikes[strikes.length - 1]} ${cw.from.slice(11, 16)}→${cw.to.slice(11, 16)}Z: PE ${pct(cw.pePct)} CE ${pct(cw.cePct)} (lean ${pct(cw.leanPct)} bullish)`,
    values: { expiry: c.expiry, from: cw.from, to: cw.to, contracts: cw.contracts, ceThen: cw.ceThen, ceNow: cw.ceNow, peThen: cw.peThen, peNow: cw.peNow, cePct: cw.cePct, pePct: cw.pePct, leanPct: cw.leanPct },
  };
}

function priceAt(prices: ReadonlyArray<{ at: Date; close: number }>, atMs: number): number | null {
  let best: { d: number; p: number } | null = null;
  for (const p of prices) {
    if (!(p.close > 0)) continue;
    const d = Math.abs(p.at.getTime() - atMs);
    if (d <= NOISE_READ.priceToleranceMin * MIN && (!best || d < best.d)) best = { d, p: p.close };
  }
  return best?.p ?? null;
}

export function futuresComponent(i: Pick<NoiseReadInput, 'at' | 'want' | 'futures'>): NoiseComponent {
  const f = i.futures;
  if (!f) return none('FUTURES', 'no future in oi_snapshots');
  const pts = buckets(f.rows, new Set([f.instrumentId])).map((b) => ({ at: b.at, oi: b.oi.get(f.instrumentId) as number }));
  const w = shortWindow(pts, i.at);
  if (!w.now || !w.then) return none('FUTURES', `${f.symbol}: ${w.note}`);
  if (!(w.then.oi > 0)) return none('FUTURES', `${f.symbol}: zero OI at ${iso(w.then.at)}`);
  const oiPct = r4((w.now.oi - w.then.oi) / w.then.oi);
  const p0 = priceAt(f.prices, w.then.at);
  const p1 = priceAt(f.prices, w.now.at);
  if (p0 === null || p1 === null) return none('FUTURES', `${f.symbol}: OI ${pct(oiPct)} but no ${f.priceSource} price near both snapshots`);
  const pricePct = r4((p1 - p0) / p0);
  const againstPct = i.want === 'BULLISH' ? -pricePct : pricePct;
  const values = { symbol: f.symbol, from: iso(w.then.at), to: iso(w.now.at), oiThen: w.then.oi, oiNow: w.now.oi, oiPct, priceThen: p0, priceNow: p1, pricePct, priceSource: f.priceSource };
  const head = `${f.symbol} ${values.from.slice(11, 16)}→${values.to.slice(11, 16)}Z: OI ${pct(oiPct)} price ${pct(pricePct)}`;
  if (againstPct < NOISE_READ.futPriceMin) return { name: 'FUTURES', lean: 'NEUTRAL', note: `${head} (price not against the position)`, values };
  const lean: NoiseLean = oiPct >= NOISE_READ.futOiMin ? 'REAL' : oiPct <= -NOISE_READ.futOiMin ? 'NOISE' : 'NEUTRAL';
  const what = lean === 'REAL' ? 'fresh positions against' : lean === 'NOISE' ? 'unwinding' : 'OI flat';
  return { name: 'FUTURES', lean, note: `${head} → ${what}`, values };
}

export function vwapComponent(i: Pick<NoiseReadInput, 'want' | 'underlying' | 'n' | 'vwap'>): NoiseComponent {
  const v = i.vwap?.value;
  if (!fin(v) || !(v > 0)) return none('VWAP', 'no VWAP (no level book VWAP for this underlying)');
  if (!fin(i.underlying) || !(i.underlying > 0)) return none('VWAP', 'no underlying price at the exit');
  if (Math.abs(i.underlying - v) / i.underlying > NOISE_READ.vwapMaxGapPct) return none('VWAP', `VWAP ${r2(v)} is not on the underlying's scale (${r2(i.underlying)})`);
  const gap = r2(i.want === 'BULLISH' ? i.underlying - v : v - i.underlying);
  const n = fin(i.n) && i.n > 0 ? i.n : null;
  const gapN = n === null ? null : r2(gap / n);
  const lean: NoiseLean = gap >= 0 ? 'NOISE' : gapN === null || gapN <= -NOISE_READ.vwapRealN ? 'REAL' : 'NEUTRAL';
  const side = gap >= 0 ? "on the position's side" : 'against the position';
  return { name: 'VWAP', lean, note: `underlying ${side} of VWAP ${r2(v)} by ${Math.abs(gap)} pts${gapN === null ? '' : ` (${gapN} N)`}`, values: { vwap: r2(v), gap, gapN, source: i.vwap?.source ?? null } };
}

export function volumeComponent(i: Pick<NoiseReadInput, 'at' | 'volume'>): NoiseComponent {
  const v = i.volume;
  if (!v) return none('VOLUME', 'no 1-minute bars with volume');
  const bars = v.bars.filter((b) => b.at.getTime() <= i.at.getTime() && fin(b.volume) && b.volume >= 0).sort((a, b) => a.at.getTime() - b.at.getTime());
  const dip = bars.slice(-NOISE_READ.volumeDipBars);
  const base = bars.slice(-(NOISE_READ.volumeDipBars + NOISE_READ.volumeBaseBars), -NOISE_READ.volumeDipBars).filter((b) => b.volume > 0);
  if (dip.length < NOISE_READ.volumeDipBars || base.length < NOISE_READ.volumeMinBaseBars) return none('VOLUME', `${v.source}: too few bars with volume (${dip.length} dip, ${base.length} base)`);
  const avg = (xs: Array<{ volume: number }>) => xs.reduce((s, b) => s + b.volume, 0) / xs.length;
  const baseAvg = avg(base);
  if (!(baseAvg > 0)) return none('VOLUME', `${v.source}: no volume before the dip`);
  const ratio = r2(avg(dip) / baseAvg);
  const lean: NoiseLean = ratio >= NOISE_READ.volumeRealRatio ? 'REAL' : ratio <= NOISE_READ.volumeNoiseRatio ? 'NOISE' : 'NEUTRAL';
  return { name: 'VOLUME', lean, note: `${v.source}: last ${dip.length} min volume ${ratio}× the ${base.length} min before`, values: { ratio, dipAvg: Math.round(avg(dip)), baseAvg: Math.round(baseAvg), source: v.source } };
}

/** Majority of the leaning components (NEUTRAL counts as read, not leaning). */
export function noiseVerdictOf(components: readonly NoiseComponent[]): NoiseVerdict {
  const read = components.filter((c) => c.lean !== null);
  if (read.length === 0) return 'NO_DATA';
  const noise = read.filter((c) => c.lean === 'NOISE').length;
  const real = read.filter((c) => c.lean === 'REAL').length;
  return noise > real ? 'NOISE' : real > noise ? 'REAL' : 'MIXED';
}

/** The read. Never throws: an error is NO_DATA with the error noted. */
export function noiseRead(i: NoiseReadInput): NoiseRead {
  const head = { want: i.want, at: i.at.toISOString() };
  try {
    const components = [moveComponent(i), chainComponent(i), futuresComponent(i), vwapComponent(i), volumeComponent(i)];
    const verdict = noiseVerdictOf(components);
    const noise = components.filter((c) => c.lean === 'NOISE').length;
    const real = components.filter((c) => c.lean === 'REAL').length;
    const parts = components.filter((c) => c.lean !== null).map((c) => `${c.name.toLowerCase()} ${c.lean!.toLowerCase()}: ${c.note}`);
    const summary = verdict === 'NO_DATA' ? 'NO_DATA: no component could be read' : `${verdict} ${noise}–${real} (want ${i.want.toLowerCase()}) ${parts.join('; ')}`;
    return { verdict, ...head, summary, components };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { verdict: 'NO_DATA', ...head, summary: `NO_DATA: error ${error}`, components: [], error };
  }
}

/** A stored read's verdict (anything unreadable is NO_DATA). */
export function noiseVerdictOfRecord(v: unknown): NoiseVerdict {
  return v === 'NOISE' || v === 'REAL' || v === 'MIXED' ? v : 'NO_DATA';
}
