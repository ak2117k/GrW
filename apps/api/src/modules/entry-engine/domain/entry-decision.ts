import type { EventContext } from '../../news-events/events/event-context';
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
  /**
   * The newest closed bar must have ended within this many minutes of `at`, else the trend is NO_DATA.
   * Prod 2026-11-03: CRUDEOIL's 1m bars stopped at 18:04 IST and the engine read "price 9218" for 2 h
   * while crude fell to 8881, then called PE after the move (owner: never decide on a frozen price).
   */
  trendMaxStaleMin: 3,
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
  /**
   * Session warm-up (self-review 2026-11-03..09): a cycle less than this many minutes after the venue's open
   * whose trend or OI is NO_DATA is INPUT_NOT_READY, not a decision (the 09:20 IST cycle has ~4 closed bars
   * against the trend's 15, and often one partial OI snapshot). Still NO_TRADE; the next cycle decides.
   */
  inputWarmupMin: 15,
});

/** The reason tag of a NO_TRADE taken because the inputs were not populated yet (session warm-up). */
export const INPUT_NOT_READY = 'INPUT_NOT_READY';

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
  /** The cluster's sources (outlets) and tagged instruments — read by the news theme; optional (older fixtures). */
  sources?: string[];
  instruments?: string[];
  /**
   * The news reader's EVENT_RISK tag (2026-11-04): a scheduled / binary / political-macro outcome
   * (election, rate decision, war / ceasefire) — a big move is expected, direction unknown. Read as
   * "move expected", never as a direction. Optional: null / absent on rows read before the tag existed.
   */
  eventRisk?: boolean | null;
}

/** Which impacts concern an underlying. Broad-market (index NIFTY) news counts for NIFTY and SENSEX. */
const NEWS_MATCH: Readonly<Record<string, { symbols: string[]; indexNames: string[]; sectors: string[] }>> = Object.freeze({
  NIFTY: { symbols: ['NIFTY'], indexNames: ['NIFTY'], sectors: [] },
  SENSEX: { symbols: ['SENSEX'], indexNames: ['NIFTY', 'SENSEX'], sectors: [] },
  BANKNIFTY: { symbols: ['BANKNIFTY'], indexNames: ['BANKNIFTY'], sectors: ['NIFTY BANK'] },
  CRUDEOIL: { symbols: ['CRUDEOIL', 'CRUDEOILM'], indexNames: [], sectors: [] },
  // 2026-11-04: bullion joined the universe. The tagger files gold / silver stories under 'MCX BULLION'
  // (news-events/keys.ts); a bullion-sector story counts for both metals (they move together).
  GOLD: { symbols: ['GOLD', 'GOLDM'], indexNames: [], sectors: ['MCX BULLION'] },
  SILVER: { symbols: ['SILVER', 'SILVERM'], indexNames: [], sectors: ['MCX BULLION'] },
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
  /** EVENT_RISK story: move expected, no direction of its own (a NEUTRAL one weighs 0). */
  eventRisk?: boolean;
}

export interface NewsReading {
  lean: ComponentLean;
  score: number;
  material: boolean;
  items: NewsItem[];
  /** Minutes since the freshest counted story was first seen; null when none. */
  freshestAgeMin: number | null;
  summary: string;
  /**
   * Which rule made the news material (2026-11-02): STORY = the original per-story rule (a MED/HIGH
   * story or a material cluster in the last 60 min); THEME = the news theme score (several same-side
   * stories / sources in 3 h, news-theme.ts); PRE_OPEN = a strong pre-open outlook bias in the opening
   * window. null / absent = not material. Set by `withNewsPaths` (news-paths.ts).
   */
  materialPath?: NewsMaterialPath | null;
  /** The extra-path reads behind it (recorded on the decision row). */
  theme?: unknown;
  preOpen?: unknown;
  /** EVENT_RISK stories among the counted ones (2026-11-04): a big move is expected, direction unknown. */
  moveExpected?: number;
}

export type NewsMaterialPath = 'STORY' | 'THEME' | 'PRE_OPEN';

const MIN = 60_000;
const IST_OFFSET_MS = 330 * MIN;
const DAY_MS = 24 * 60 * MIN;
/** Epoch ms of the IST midnight that starts the day of `t`. */
const istDayStart = (t: number) => Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
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
  const dayStart = istDayStart(t);
  const byCluster = new Map<string, ImpactRow>();
  for (const r of impacts) {
    const a = r.analysedAt.getTime();
    // A MED / HIGH story not yet priced in is remembered for the IST day (2026-11-09: the Iran talks read BEAR MED
    // at 07:15 and crude fell ~3% that evening while the engine saw "no news").
    const remembered = a >= dayStart && !r.pricedIn && ENTRY_ENGINE.newsMaterialMagnitudes.includes(String(r.magnitude).toUpperCase());
    if (!((a > from || remembered) && a <= t)) continue;
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
        ...(r.eventRisk === true ? { eventRisk: true } : {}),
      };
    });
  const score = r4(items.reduce((s, i) => s + i.weight, 0));
  if (items.length === 0) return { lean: 'NO_DATA', score: 0, material: false, items, freshestAgeMin: null, summary: `no news read in the last ${ENTRY_ENGINE.newsLookbackMin} min` };
  // EVENT_RISK adds "move expected" to the read, never a direction: the score above is untouched by it.
  const moveExpected = items.filter((i) => i.eventRisk).length;
  const moveNote = moveExpected > 0 ? `; move expected (${moveExpected} EVENT_RISK stor${moveExpected === 1 ? 'y' : 'ies'}, no direction)` : '';
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
    materialPath: material ? 'STORY' : null,
    ...(moveExpected > 0 ? { moveExpected } : {}),
    summary: `${lean.toLowerCase()} score ${score} from ${items.length} stor${items.length === 1 ? 'y' : 'ies'}${material ? ' (material)' : ''}; latest: ${top.direction} ${top.magnitude} ${top.confidence} "${top.headline.slice(0, 80)}"${moveNote}`,
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
  const last = session[session.length - 1];
  const staleMin = Math.floor((t - (last.ts + MIN)) / MIN);
  if (staleMin > ENTRY_ENGINE.trendMaxStaleMin) {
    return { ...empty, summary: `NO_DATA: stale — the last 1m bar closed ${staleMin} min ago (> ${ENTRY_ENGINE.trendMaxStaleMin}) at ${last.close}` };
  }
  const price = last.close;
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
  /**
   * The event view for the underlying (news-events eventContextFor, 2026-11-04). It never picks a direction
   * (an event day predicts move SIZE): with an expectMove event it only waives the NEWS requirement, so the
   * trend names the side and OI must confirm it (see entryDecision, the event-day news waiver).
   * Absent / undefined = not read (older callers, the replay).
   */
  event?: EventContext | null;
  /** The venue session's open; with it, a NO_DATA trend / OI in the warm-up is INPUT_NOT_READY. Absent = not checked (the replay). */
  sessionStart?: Date | null;
}

/** One line for the decision's reasons; null when the event view was not read. */
export function eventReason(underlying: string, e: EventContext | null | undefined): string | null {
  if (!e) return null;
  if (e.status === 'absent') return `event: absent — ${e.reason}`;
  if (e.events.length === 0) return `event: none scheduled affecting ${underlying.toUpperCase()}`;
  const names = e.events.map((x) => `${x.name} (${x.at}, ${x.impact})`).join('; ');
  const move = e.events.some((x) => x.expectMove);
  return `event: ${names}${move ? ' — big move expected, direction unknown' : ''}`;
}

export interface EntryDecision {
  action: EngineAction;
  /** The direction all three agreed on (null for NO_TRADE). */
  direction: Direction | null;
  /** Set only on an INPUT_NOT_READY NO_TRADE: the components not populated yet (trend / oi). */
  inputNotReady?: string[];
  reasons: string[];
  scores: {
    news: number;
    newsLean: ComponentLean;
    newsMaterial: boolean;
    newsMaterialPath: NewsMaterialPath | null;
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
 * way and futures OI (when captured) is not against it — except on an expectMove event day, where
 * absent / non-material news is waived and the trend names the side. Everything else is NO_TRADE with
 * the failing component(s) named. Pure and deterministic.
 */
export function entryDecision(i: EntryInput): EntryDecision {
  const reasons: string[] = [];
  const oLean = oiLean(i.oi);
  const scores: EntryDecision['scores'] = {
    news: i.news.score,
    newsLean: i.news.lean,
    newsMaterial: i.news.material,
    newsMaterialPath: i.news.material ? i.news.materialPath ?? 'STORY' : null,
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
  const newsDir: Direction | null = i.news.lean === 'BULLISH' || i.news.lean === 'BEARISH' ? i.news.lean : null;
  // EVENT-DAY NEWS WAIVER (2026-11-04 evening, owner "go ahead"). Prod: from 17:35 IST CRUDEOIL's trend read
  // BEARISH on every check and at 19:35 OI AGREED, but news was NO_DATA / NEUTRAL ("already realised"), so the
  // engine never entered while crude fell ~450 pts after the US midterms. On a day whose event view expects a big
  // move for this underlying, missing or non-material news no longer blocks: the TREND names the direction and
  // OI must still confirm it. News that points the OTHER way still blocks (that is evidence, not absence).
  const eventMove = i.event?.status === 'present' && i.event.events.some((e) => e.expectMove);
  const trendDir: Direction | null = i.trend.lean === 'BULLISH' || i.trend.lean === 'BEARISH' ? i.trend.lean : null;
  const newsWaived = eventMove && trendDir !== null && (!newsDir || !i.news.material) && (!newsDir || newsDir === trendDir);
  const dir: Direction | null = newsWaived ? trendDir : newsDir;
  let ok = true;

  if (newsWaived) {
    reasons.push(`news: waived on an event day (big move expected) — direction from the trend ${dir}; news ${i.news.lean} — ${i.news.summary}`);
  } else if (!dir) {
    ok = false;
    reasons.push(`news: ${i.news.lean} — ${i.news.summary}`);
  } else if (!i.news.material) {
    ok = false;
    reasons.push(`news: ${dir} but not material (needs a ${ENTRY_ENGINE.newsMaterialMagnitudes.join('/')} story on that side, a material theme or a strong pre-open bias) — ${i.news.summary}`);
  } else {
    reasons.push(`news: ${dir} ✓${i.news.materialPath ? ` (material via ${i.news.materialPath})` : ''} — ${i.news.summary}`);
  }

  if (i.trend.lean === 'NO_DATA' || i.trend.lean === 'NEUTRAL') {
    ok = false;
    reasons.push(`trend: ${i.trend.lean} — ${i.trend.summary}`);
  } else if (dir && i.trend.lean !== dir) {
    ok = false;
    reasons.push(`trend: ${i.trend.lean} disagrees with news ${dir} — ${i.trend.summary}`);
  } else if (newsWaived) {
    reasons.push(`trend: ${i.trend.lean} ✓ (sets the direction on the event day) — ${i.trend.summary}`);
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

  const ev = eventReason(i.underlying, i.event);
  if (ev) reasons.push(ev);

  // Session warm-up: trend / OI not populated yet is "not ready", not a decision (the component reasons stay for audit).
  const sinceOpenMin = i.sessionStart ? (i.at.getTime() - i.sessionStart.getTime()) / MIN : null;
  const notReady = [...(i.trend.lean === 'NO_DATA' ? ['trend'] : []), ...(oLean === 'NO_DATA' ? ['oi'] : [])];
  if (sinceOpenMin !== null && sinceOpenMin < ENTRY_ENGINE.inputWarmupMin && notReady.length > 0) {
    const head = `${INPUT_NOT_READY}: ${notReady.join(' + ')} not populated ${Math.round(sinceOpenMin)} min after the session open — no decision this cycle, retry next cycle`;
    return { action: 'NO_TRADE', direction: null, inputNotReady: notReady, reasons: [head, ...reasons], scores };
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
