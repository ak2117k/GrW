import type { OiCheck, OiVerdict } from '../../signal-trader/domain/oi-check';

/**
 * ENTRY ENGINE, stage 1 (owner 2026-10-30): "collect news, technicals and OI, analyse, and take the
 * decision". Prod 2026-10-29: crude fell ~230 pts on bearish Hormuz / supply headlines and no PE was
 * taken — nothing in the app creates a trade by itself; only Telegram signals do.
 *
 * The decision is CODE, deterministic and explainable (no LLM call): the news read is the existing
 * cheap-model news impact (news_impacts: direction / magnitude / confidence per cluster), the trend
 * is price vs the session VWAP and the 15m / 1h EMA slopes from 1-minute bars, and the OI is the
 * signal-trader OI check (chain lean over ~30 min and since the open; futures buildup for NFO).
 *
 *   ENTER_CE / ENTER_PE only when news, trend and OI ALL point the same way ("if all are with us,
 *   then we are good to go"). Any disagreement, a neutral component, or NO_DATA on OI → NO_TRADE.
 *
 * Every threshold is a named constant in {@link ENTRY_ENGINE}. Pure: no I/O, no clock.
 */

export type EngineAction = 'ENTER_CE' | 'ENTER_PE' | 'NO_TRADE';
export type Direction = 'BULLISH' | 'BEARISH';
export type ComponentLean = Direction | 'NEUTRAL' | 'NO_DATA';

export const ENTRY_ENGINE = Object.freeze({
  /** News impacts analysed within this many minutes before the evaluation count ("fresh"). */
  newsLookbackMin: 60,
  /** An impact below this model confidence is ignored. */
  newsMinConfidence: 0.4,
  /** Weight of an impact by its magnitude; the signed sum of weight × confidence is the news score. */
  newsMagnitudeWeight: Object.freeze({ LOW: 0.25, MED: 0.6, HIGH: 1 }) as Readonly<Record<string, number>>,
  /** An impact the model says is already priced in counts this much. */
  newsPricedInFactor: 0.5,
  /** |news score| at or above this leans (0.6 × 0.5 = one MED impact at 0.5 confidence → 0.30). */
  newsMinScore: 0.25,
  /**
   * "Material": at least one impact on the lean's side with magnitude MED / HIGH, or a cluster the
   * classifier flagged material. Several LOW impacts alone never make an entry.
   */
  newsMaterialMagnitudes: Object.freeze(['MED', 'HIGH']) as readonly string[],

  /** Price must be this far beyond the session VWAP (0.05%) to count as above / below it. */
  trendVwapMinPct: 0.0005,
  /** At least this many closed 1-minute bars this session before the trend can be read. */
  trendMinSessionBars: 15,
  /** EMA period on 15-minute and 1-hour closes (aggregated from the 1-minute bars). */
  ema15Period: 9,
  ema1hPeriod: 9,
  /** Slope = (EMA now − EMA k bars ago) / price; 15m over 3 bars, 1h over 2 bars. */
  ema15SlopeBars: 3,
  ema1hSlopeBars: 2,
  /** |15m slope| at or above 0.03% leans; the 1h slope only has to not point against (≥ 0 / ≤ 0). */
  ema15SlopeMinPct: 0.0003,
  /** A volume series where ≥ this share of bars do not drop is cumulative (not per-bar) → TWAP instead. */
  cumulativeVolumeShare: 0.85,
  /**
   * …or whose last-quarter median is ≥ this many times its first-quarter median (per-bar volume is
   * U-shaped through a session; a running total only grows — the prod crude `candles` 1m volume grows ~150× over 2026-10-29).
   */
  cumulativeVolumeRatio: 4,

  /** Cooldowns (paper): one open engine trade per underlying, three a day in total. */
  maxOpenPerUnderlying: 1,
  maxTradesPerDay: 3,
  /** No entry in the last 30 min of the session. */
  noEntryLastMin: 30,
});

// ───────────────────────────── news ─────────────────────────────

/** One news_impacts row joined to its cluster (news-impact layer 2). */
export interface ImpactRow {
  clusterId: string;
  analysedAt: Date;
  firstSeen: Date;
  /** BULL | BEAR | NEUTRAL */
  direction: string;
  /** LOW | MED | HIGH */
  magnitude: string;
  confidence: number;
  pricedIn: boolean;
  symbols: string[];
  sectors: string[];
  indexName: string | null;
  material: boolean;
  materialType: string | null;
  headline: string;
}

/** Which impacts concern an underlying. Broad-market (index NIFTY) news counts for NIFTY and SENSEX. */
const NEWS_MATCH: Readonly<Record<string, { symbols: string[]; indexNames: string[]; sectors: string[] }>> = Object.freeze({
  NIFTY: { symbols: ['NIFTY'], indexNames: ['NIFTY'], sectors: [] },
  SENSEX: { symbols: ['SENSEX'], indexNames: ['NIFTY', 'SENSEX'], sectors: [] },
  BANKNIFTY: { symbols: ['BANKNIFTY'], indexNames: ['BANKNIFTY'], sectors: ['NIFTY BANK'] },
  CRUDEOIL: { symbols: ['CRUDEOIL', 'CRUDEOILM'], indexNames: [], sectors: [] },
});

export function impactConcerns(underlying: string, r: Pick<ImpactRow, 'symbols' | 'sectors' | 'indexName'>): boolean {
  const u = underlying.toUpperCase();
  const m = NEWS_MATCH[u] ?? { symbols: [u], indexNames: [], sectors: [] };
  const up = (xs: readonly string[]) => xs.map((x) => String(x).toUpperCase());
  return (
    up(r.symbols ?? []).some((s) => m.symbols.includes(s)) ||
    (r.indexName !== null && m.indexNames.includes(String(r.indexName).toUpperCase())) ||
    up(r.sectors ?? []).some((s) => m.sectors.includes(s))
  );
}

export interface NewsItem {
  clusterId: string;
  direction: string;
  magnitude: string;
  confidence: number;
  pricedIn: boolean;
  material: boolean;
  /** Signed contribution to the score (+ bullish). */
  weight: number;
  /** Minutes since the story was first seen / since the model read it. */
  ageMin: number;
  readAgoMin: number;
  headline: string;
}

export interface NewsReading {
  lean: ComponentLean;
  score: number;
  material: boolean;
  items: NewsItem[];
  /** Minutes since the freshest counted story was first seen; null when none. */
  freshestAgeMin: number | null;
  summary: string;
}

const MIN = 60_000;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`);

/**
 * The news lean for one underlying at `at`: impacts the model READ in (at − lookback, at] (what the
 * app actually knew then — no look-ahead), concerning it, confidence ≥ min. One row per cluster.
 */
export function newsReading(impacts: readonly ImpactRow[], underlying: string, at: Date): NewsReading {
  const t = at.getTime();
  const from = t - ENTRY_ENGINE.newsLookbackMin * MIN;
  const byCluster = new Map<string, ImpactRow>();
  for (const r of impacts) {
    const a = r.analysedAt.getTime();
    if (!(a > from && a <= t)) continue;
    if (!(r.confidence >= ENTRY_ENGINE.newsMinConfidence)) continue;
    if (!impactConcerns(underlying, r)) continue;
    const prev = byCluster.get(r.clusterId);
    if (!prev || prev.analysedAt.getTime() < a) byCluster.set(r.clusterId, r);
  }
  const items: NewsItem[] = [...byCluster.values()]
    .sort((a, b) => b.analysedAt.getTime() - a.analysedAt.getTime())
    .map((r) => {
      const dir = String(r.direction).toUpperCase();
      const sign = dir === 'BULL' ? 1 : dir === 'BEAR' ? -1 : 0;
      const w = (ENTRY_ENGINE.newsMagnitudeWeight[String(r.magnitude).toUpperCase()] ?? 0) * r.confidence * (r.pricedIn ? ENTRY_ENGINE.newsPricedInFactor : 1);
      return {
        clusterId: r.clusterId,
        direction: dir,
        magnitude: String(r.magnitude).toUpperCase(),
        confidence: r.confidence,
        pricedIn: r.pricedIn,
        material: r.material,
        weight: r4(sign * w),
        ageMin: r1((t - r.firstSeen.getTime()) / MIN),
        readAgoMin: r1((t - r.analysedAt.getTime()) / MIN),
        headline: r.headline.slice(0, 160),
      };
    });
  const score = r4(items.reduce((s, i) => s + i.weight, 0));
  if (items.length === 0) return { lean: 'NO_DATA', score: 0, material: false, items, freshestAgeMin: null, summary: `no news read in the last ${ENTRY_ENGINE.newsLookbackMin} min` };
  const lean: ComponentLean = score >= ENTRY_ENGINE.newsMinScore ? 'BULLISH' : score <= -ENTRY_ENGINE.newsMinScore ? 'BEARISH' : 'NEUTRAL';
  const side = lean === 'BULLISH' ? 'BULL' : lean === 'BEARISH' ? 'BEAR' : null;
  const material = side !== null && items.some((i) => i.direction === side && (ENTRY_ENGINE.newsMaterialMagnitudes.includes(i.magnitude) || i.material));
  const freshestAgeMin = Math.min(...items.map((i) => i.ageMin));
  const top = items[0];
  return {
    lean,
    score,
    material,
    items,
    freshestAgeMin,
    summary: `${lean.toLowerCase()} score ${score} from ${items.length} stor${items.length === 1 ? 'y' : 'ies'}${material ? ' (material)' : ''}; latest: ${top.direction} ${top.magnitude} ${top.confidence} "${top.headline.slice(0, 80)}"`,
  };
}

// ───────────────────────────── trend ─────────────────────────────

export interface Bar1m {
  /** Bar open (ms epoch). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TrendReading {
  lean: ComponentLean;
  price: number | null;
  vwap: number | null;
  vwapSource: 'VWAP' | 'TWAP' | null;
  /** (price − vwap) / vwap. */
  vwapPct: number | null;
  ema15: number | null;
  ema15Slope: number | null;
  ema1h: number | null;
  ema1hSlope: number | null;
  sessionBars: number;
  summary: string;
}

/** EMA of `xs` (seeded with the first value); [] for none. */
export function ema(xs: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (const x of xs) out.push(out.length === 0 ? x : x * k + out[out.length - 1] * (1 - k));
  return out;
}

/** Closes of `minutes`-wide buckets (aligned to the epoch, i.e. IST :00/:15/:30/:45) fully closed by `at`. */
export function bucketCloses(bars: readonly Bar1m[], minutes: number, at: number): number[] {
  const w = minutes * MIN;
  const by = new Map<number, { ts: number; close: number }>();
  for (const b of bars) {
    if (b.ts + MIN > at || !(b.close > 0)) continue;
    const k = Math.floor(b.ts / w) * w;
    const prev = by.get(k);
    if (!prev || prev.ts < b.ts) by.set(k, { ts: b.ts, close: b.close });
  }
  return [...by.entries()].filter(([k]) => k + w <= at).sort((a, b) => a[0] - b[0]).map(([, v]) => v.close);
}

/** Per-bar volume is usable for a VWAP: positive and not a running (cumulative) total. */
export function volumeUsable(bars: readonly Bar1m[]): boolean {
  if (bars.length < 2) return false;
  if (!bars.every((b) => b.volume > 0)) return false;
  let notDown = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i].volume >= bars[i - 1].volume) notDown++;
  if (notDown / (bars.length - 1) >= ENTRY_ENGINE.cumulativeVolumeShare) return false;
  const q = Math.floor(bars.length / 4);
  if (q >= 3) {
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const first = med(bars.slice(0, q).map((b) => b.volume));
    const last = med(bars.slice(-q).map((b) => b.volume));
    if (first > 0 && last / first >= ENTRY_ENGINE.cumulativeVolumeRatio) return false;
  }
  return true;
}

/**
 * Trend at `at` from closed 1-minute bars of the underlying's line (the index, or an MCX underlying's
 * nearest future): price vs this session's VWAP (TWAP when the line has no per-bar volume — index
 * volume is 0), and the 9-EMA slopes of 15-minute and 1-hour closes built from the same bars.
 * BULLISH = above VWAP, 15m slope up and 1h slope not down; BEARISH the mirror; else NEUTRAL.
 */
export function trendReading(bars: readonly Bar1m[], at: Date, sessionStart: Date): TrendReading {
  const t = at.getTime();
  const closed = bars.filter((b) => b.ts + MIN <= t && b.close > 0).sort((a, b) => a.ts - b.ts);
  const session = closed.filter((b) => b.ts >= sessionStart.getTime());
  const empty: TrendReading = { lean: 'NO_DATA', price: null, vwap: null, vwapSource: null, vwapPct: null, ema15: null, ema15Slope: null, ema1h: null, ema1hSlope: null, sessionBars: session.length, summary: '' };
  if (session.length < ENTRY_ENGINE.trendMinSessionBars) return { ...empty, summary: `NO_DATA: ${session.length} closed 1m bars this session (< ${ENTRY_ENGINE.trendMinSessionBars})` };
  const price = session[session.length - 1].close;
  const useVol = volumeUsable(session);
  let num = 0, den = 0;
  for (const b of session) {
    const tp = (b.high + b.low + b.close) / 3;
    const w = useVol ? b.volume : 1;
    num += tp * w;
    den += w;
  }
  const vwap = den > 0 ? num / den : null;
  const vwapPct = vwap ? r4((price - vwap) / vwap) : null;

  const slopeOf = (minutes: number, period: number, k: number) => {
    const closes = bucketCloses(closed, minutes, t);
    if (closes.length < period + k) return { ema: null, slope: null };
    const e = ema(closes, period);
    const now = e[e.length - 1];
    return { ema: Math.round(now * 100) / 100, slope: r4((now - e[e.length - 1 - k]) / price) };
  };
  const m15 = slopeOf(15, ENTRY_ENGINE.ema15Period, ENTRY_ENGINE.ema15SlopeBars);
  const h1 = slopeOf(60, ENTRY_ENGINE.ema1hPeriod, ENTRY_ENGINE.ema1hSlopeBars);
  const base = { price, vwap: vwap ? Math.round(vwap * 100) / 100 : null, vwapSource: (useVol ? 'VWAP' : 'TWAP') as 'VWAP' | 'TWAP', vwapPct, ema15: m15.ema, ema15Slope: m15.slope, ema1h: h1.ema, ema1hSlope: h1.slope, sessionBars: session.length };
  const parts = `price ${price} vs ${base.vwapSource} ${base.vwap} (${pct(vwapPct)}), 15m EMA slope ${pct(m15.slope)}, 1h EMA slope ${pct(h1.slope)}`;
  if (vwapPct === null || m15.slope === null || h1.slope === null) {
    return { ...base, lean: 'NO_DATA', summary: `NO_DATA: not enough history for the ${m15.slope === null ? '15m' : '1h'} EMA — ${parts}` };
  }
  const bull = vwapPct >= ENTRY_ENGINE.trendVwapMinPct && m15.slope >= ENTRY_ENGINE.ema15SlopeMinPct && h1.slope >= 0;
  const bear = vwapPct <= -ENTRY_ENGINE.trendVwapMinPct && m15.slope <= -ENTRY_ENGINE.ema15SlopeMinPct && h1.slope <= 0;
  const lean: ComponentLean = bull ? 'BULLISH' : bear ? 'BEARISH' : 'NEUTRAL';
  return { ...base, lean, summary: `${lean.toLowerCase()}: ${parts}` };
}

// ───────────────────────────── OI ─────────────────────────────

export interface OiReading {
  /** The direction the check was run for (the news lean, else the trend lean, else BULLISH). */
  want: Direction;
  /** oiCheck verdict: chain first, futures when the chain cannot lean. */
  verdict: OiVerdict;
  source: OiCheck['source'];
  /** Futures buildup verdict on its own (NFO), NO_DATA when not captured (MCX futures OI is not). */
  futuresVerdict: OiVerdict;
  summary: string;
  chainLeanAgo: number | null;
  chainLeanOpen: number | null;
}

/** The OI component as the decision reads it: the oiCheck result plus the futures-only verdict. */
export function oiReading(check: OiCheck, futuresVerdict: OiVerdict): OiReading {
  return {
    want: check.want,
    verdict: check.verdict,
    source: check.source,
    futuresVerdict,
    summary: check.summary,
    chainLeanAgo: check.chain?.windows.ago?.leanPct ?? null,
    chainLeanOpen: check.chain?.windows.open?.leanPct ?? null,
  };
}

/** The lean the OI check supports: AGREES → its want; AGAINST → the opposite; else NEUTRAL / NO_DATA. */
export function oiLean(o: OiReading | null): ComponentLean {
  if (!o || o.verdict === 'NO_DATA') return 'NO_DATA';
  if (o.verdict === 'AGREES') return o.want;
  if (o.verdict === 'AGAINST') return o.want === 'BULLISH' ? 'BEARISH' : 'BULLISH';
  return 'NEUTRAL';
}

// ───────────────────────────── decision ─────────────────────────────

export interface EntryInput {
  underlying: string;
  at: Date;
  news: NewsReading;
  trend: TrendReading;
  oi: OiReading | null;
}

export interface EntryDecision {
  action: EngineAction;
  /** The direction all three agreed on (null for NO_TRADE). */
  direction: Direction | null;
  reasons: string[];
  scores: {
    news: number;
    newsLean: ComponentLean;
    newsMaterial: boolean;
    trendLean: ComponentLean;
    vwapPct: number | null;
    ema15Slope: number | null;
    ema1hSlope: number | null;
    oiLean: ComponentLean;
    oiVerdict: OiVerdict;
    futuresVerdict: OiVerdict;
    chainLeanAgo: number | null;
    chainLeanOpen: number | null;
  };
}

/**
 * The entry decision. ENTER only when news (leaning AND material), trend and OI all point the same
 * way and futures OI (when captured) is not against it. Everything else is NO_TRADE with the
 * failing component(s) named. Pure and deterministic.
 */
export function entryDecision(i: EntryInput): EntryDecision {
  const reasons: string[] = [];
  const oLean = oiLean(i.oi);
  const scores: EntryDecision['scores'] = {
    news: i.news.score,
    newsLean: i.news.lean,
    newsMaterial: i.news.material,
    trendLean: i.trend.lean,
    vwapPct: i.trend.vwapPct,
    ema15Slope: i.trend.ema15Slope,
    ema1hSlope: i.trend.ema1hSlope,
    oiLean: oLean,
    oiVerdict: i.oi?.verdict ?? 'NO_DATA',
    futuresVerdict: i.oi?.futuresVerdict ?? 'NO_DATA',
    chainLeanAgo: i.oi?.chainLeanAgo ?? null,
    chainLeanOpen: i.oi?.chainLeanOpen ?? null,
  };
  const dir: Direction | null = i.news.lean === 'BULLISH' || i.news.lean === 'BEARISH' ? i.news.lean : null;
  let ok = true;

  if (!dir) {
    ok = false;
    reasons.push(`news: ${i.news.lean} — ${i.news.summary}`);
  } else if (!i.news.material) {
    ok = false;
    reasons.push(`news: ${dir} but not material (needs a ${ENTRY_ENGINE.newsMaterialMagnitudes.join('/')} story on that side) — ${i.news.summary}`);
  } else {
    reasons.push(`news: ${dir} ✓ — ${i.news.summary}`);
  }

  if (i.trend.lean === 'NO_DATA' || i.trend.lean === 'NEUTRAL') {
    ok = false;
    reasons.push(`trend: ${i.trend.lean} — ${i.trend.summary}`);
  } else if (dir && i.trend.lean !== dir) {
    ok = false;
    reasons.push(`trend: ${i.trend.lean} disagrees with news ${dir} — ${i.trend.summary}`);
  } else {
    reasons.push(`trend: ${i.trend.lean}${dir ? ' ✓' : ''} — ${i.trend.summary}`);
  }

  const o = i.oi;
  if (!o || oLean === 'NO_DATA') {
    ok = false;
    reasons.push(`oi: NO_DATA — ${o?.summary ?? 'no OI read'}`);
  } else if (!dir) {
    ok = false;
    reasons.push(`oi: ${o.verdict} for ${o.want} (${oLean}; no news direction to confirm) — ${o.summary}`);
  } else if (o.want !== dir || oLean !== dir) {
    ok = false;
    reasons.push(`oi: ${o.verdict} for ${o.want} (${oLean}) does not confirm ${dir} — ${o.summary}`);
  } else if (o.futuresVerdict === 'AGAINST') {
    ok = false;
    reasons.push(`oi: chain agrees but futures buildup is AGAINST ${dir} — ${o.summary}`);
  } else {
    reasons.push(`oi: AGREES ✓ (futures ${o.futuresVerdict}) — ${o.summary}`);
  }

  if (!ok || !dir) return { action: 'NO_TRADE', direction: null, reasons, scores };
  return { action: dir === 'BULLISH' ? 'ENTER_CE' : 'ENTER_PE', direction: dir, reasons, scores };
}

// ───────────────────────────── cooldowns ─────────────────────────────

export interface GuardFacts {
  /** Open ENGINE_ENTRY paper trades on this underlying. */
  openForUnderlying: number;
  /** ENGINE_ENTRY trades opened today (IST), any underlying. */
  tradesToday: number;
  /** Minutes to the venue's close (holiday-aware); null = unreadable (fails closed). */
  minutesToClose: number | null;
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

/** The paper cooldowns. Any unreadable fact blocks (fails closed). */
export function entryGuards(g: GuardFacts): GuardResult {
  const reasons: string[] = [];
  if (g.openForUnderlying >= ENTRY_ENGINE.maxOpenPerUnderlying) reasons.push(`cooldown: ${g.openForUnderlying} engine trade(s) already open on this underlying (max ${ENTRY_ENGINE.maxOpenPerUnderlying})`);
  if (g.tradesToday >= ENTRY_ENGINE.maxTradesPerDay) reasons.push(`cooldown: ${g.tradesToday} engine trades today (max ${ENTRY_ENGINE.maxTradesPerDay})`);
  if (g.minutesToClose === null) reasons.push('session: minutes to close unreadable');
  else if (g.minutesToClose < ENTRY_ENGINE.noEntryLastMin) reasons.push(`session: ${g.minutesToClose} min to close (no entries in the last ${ENTRY_ENGINE.noEntryLastMin})`);
  return { ok: reasons.length === 0, reasons };
}
