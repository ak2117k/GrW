/**
 * Evidence for the action plan (owner 2026-11-02: "tell the things one CAN do … by doing analysis, news,
 * OI and other things"). Pure: daily-candle trend, momentum, recent material news, futures OI build-up
 * and upcoming events → small named classes the rules in action-plan.ts read. Nothing here decides an
 * action; it only labels what the data says.
 *
 * News is CONTEXT, never a sole reason: the news-impact model is about a coin flip on direction
 * (self-review 2026-10/11), so a NEGATIVE news class can only tip an already-weak holding, never
 * create an EXIT on its own, and POSITIVE news never creates an ADD.
 */
import { recapKind } from '../../news-impact/domain/recap';
import type { HoldingTrend, MomentumClass, NewsClass, NewsItem, OiBuildup, OiClass, OiEvidence, TrendClass, UpcomingEvent, Evidence, EvidenceChip } from './types';

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const EVIDENCE_RULES = {
  /** STRONG_UP needs the price within this % of its 52-week high. */
  strongMaxFromHighPct: 15,
  /** Momentum: 1-month return above +this % is POSITIVE, below −this % NEGATIVE. */
  momentumBandPct: 2,
  /** OI window: the last this many sessions. */
  oiSessions: 5,
  /** OI change smaller than this % over the window is FLAT (no build-up). */
  oiFlatPct: 2,
  /** Price change smaller than this % over the window counts as no direction (FLAT). */
  oiPriceFlatPct: 0.5,
  /** News look-back (days) and the magnitudes that count. */
  newsDays: 7,
  /** Upcoming events window (days). */
  eventDays: 21,
} as const;

/**
 * Trend from daily candles (price = last close, or the live LTP when given):
 *  - STRONG_UP: price above its 20-DMA and 50-DMA, 50-DMA > 200-DMA and price > 200-DMA (no 200: 6-month return > 0),
 *               6-month return > 0, and within 15% of the 52-week high
 *  - UP:        price > 50-DMA and (price > 200-DMA, or 6-month return ≥ 0 without a 200-DMA)
 *  - DOWN:      price < 200-DMA (no 200: price < 50-DMA and 6-month return < 0)
 *  - WEAK:      anything else (below the 50-DMA but above the long trend)
 */
export function classifyTrend(t: HoldingTrend, price: number | null): TrendClass {
  if (t.status !== 'OK' || t.dma50 === null) return 'NO_DATA';
  const p = price ?? t.lastClose ?? null;
  if (p === null || !(p > 0)) return 'NO_DATA';
  const ret6m = t.ret6m ?? 0;
  const below200 = t.dma200 !== null ? p < t.dma200 : p < t.dma50 && ret6m < 0;
  if (below200) return 'DOWN';
  const longUp = t.dma200 !== null ? t.dma50 > t.dma200 && p > t.dma200 : ret6m > 0;
  const fromHigh = t.high52w ? ((t.high52w - p) / t.high52w) * 100 : null;
  const above20 = t.dma20 == null || p > t.dma20;
  if (p > t.dma50 && longUp && above20 && ret6m > 0 && fromHigh !== null && fromHigh <= EVIDENCE_RULES.strongMaxFromHighPct) return 'STRONG_UP';
  if (p > t.dma50 && (t.dma200 !== null ? p > t.dma200 : ret6m >= 0)) return 'UP';
  return 'WEAK';
}

export function classifyMomentum(t: HoldingTrend): MomentumClass {
  if (t.status !== 'OK' || t.ret1m == null) return 'NO_DATA';
  if (t.ret1m > EVIDENCE_RULES.momentumBandPct) return 'POSITIVE';
  if (t.ret1m < -EVIDENCE_RULES.momentumBandPct) return 'NEGATIVE';
  return 'FLAT';
}

/** A raw news read (news_impacts ⋈ news_clusters) before the material / recap filter. */
export interface RawNews {
  at: Date;
  headline: string;
  direction: string;
  magnitude: string;
  oneLine: string;
  boilerplate?: boolean;
}

/**
 * Keep only material reads: MED / HIGH magnitude, not boilerplate, not a recap / wrap / list headline
 * (news-impact/domain/recap.ts), not the model's own "[recap]" one-liner; newest first, at most 5.
 */
export function materialNews(rows: RawNews[], now: Date): NewsItem[] {
  const since = now.getTime() - EVIDENCE_RULES.newsDays * 86_400_000;
  return rows
    .filter((r) => r.at.getTime() >= since && r.at.getTime() <= now.getTime() + 60_000)
    .filter((r) => r.magnitude === 'MED' || r.magnitude === 'HIGH')
    .filter((r) => !r.boilerplate && !recapKind(r.headline) && !String(r.oneLine ?? '').startsWith('[recap]'))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 5)
    .map((r) => ({ at: r.at.toISOString(), headline: r.headline.slice(0, 200), direction: r.direction, magnitude: r.magnitude, oneLine: String(r.oneLine ?? '').slice(0, 200) }));
}

export function classifyNews(items: NewsItem[]): NewsClass {
  const bull = items.filter((i) => i.direction === 'BULL').length;
  const bear = items.filter((i) => i.direction === 'BEAR').length;
  if (bull === 0 && bear === 0) return 'NONE';
  if (bull > bear) return 'POSITIVE';
  if (bear > bull) return 'NEGATIVE';
  return 'MIXED';
}

/** Price × OI direction over a window. */
export function buildupKind(pricePct: number, oiPct: number): OiBuildup {
  if (Math.abs(oiPct) < EVIDENCE_RULES.oiFlatPct) return 'FLAT';
  if (Math.abs(pricePct) < EVIDENCE_RULES.oiPriceFlatPct) return 'FLAT';
  if (pricePct > 0) return oiPct > 0 ? 'LONG_BUILDUP' : 'SHORT_COVERING';
  return oiPct > 0 ? 'SHORT_BUILDUP' : 'LONG_UNWINDING';
}

/** LONG_BUILDUP supports a long; SHORT_BUILDUP / LONG_UNWINDING work against it; covering / flat are neutral. */
export function oiClassOf(b: OiBuildup): OiClass {
  if (b === 'LONG_BUILDUP') return 'SUPPORTIVE';
  if (b === 'SHORT_BUILDUP' || b === 'LONG_UNWINDING') return 'ADVERSE';
  return 'NEUTRAL';
}

export const OI_NOT_FNO: OiEvidence = { status: 'NOT_FNO', source: null, sessions: 0, pricePct: null, oiPct: null, buildup: null, days: [] };
export const OI_NO_DATA = (reason: string, source: OiEvidence['source'] = null): OiEvidence => ({ status: 'NO_DATA', source, sessions: 0, pricePct: null, oiPct: null, buildup: null, days: [], reason });

/**
 * Futures OI evidence from per-session (date, close, oi) points (oldest or any order). Uses the last
 * `oiSessions` + 1 points: the window's aggregate price % and OI % classify it; each day's own kind
 * is kept as detail. Fewer than 3 sessions → NO_DATA.
 */
export function oiEvidence(points: ReadonlyArray<{ date: string; close: number; oi: number }>, source: 'BROKER' | 'SNAPSHOTS'): OiEvidence {
  const s = [...points].filter((d) => d.close > 0 && d.oi > 0).sort((a, b) => a.date.localeCompare(b.date));
  const w = s.slice(-(EVIDENCE_RULES.oiSessions + 1));
  if (w.length < 3) return OI_NO_DATA(`only ${w.length} session(s) of futures OI`, source);
  const first = w[0];
  const last = w[w.length - 1];
  const pricePct = round2(((last.close - first.close) / first.close) * 100);
  const oiPct = round2(((last.oi - first.oi) / first.oi) * 100);
  const buildup = buildupKind(pricePct, oiPct);
  const days = w.slice(1).map((d, i) => ({ date: d.date, kind: buildupKind(((d.close - w[i].close) / w[i].close) * 100, ((d.oi - w[i].oi) / w[i].oi) * 100) }));
  return { status: oiClassOf(buildup), source, sessions: w.length - 1, pricePct, oiPct, buildup, days };
}

export interface EvidenceInput {
  trend: HoldingTrend;
  price: number | null;
  news: NewsItem[];
  oi: OiEvidence;
  events: UpcomingEvent[];
  sector: string | null;
}

export function buildEvidence(i: EvidenceInput): Evidence {
  const t = i.trend;
  const p = i.price ?? t.lastClose ?? null;
  const ok = t.status === 'OK';
  return {
    trend: classifyTrend(t, p),
    momentum: classifyMomentum(t),
    close: p,
    dma20: ok ? t.dma20 ?? null : null,
    dma50: ok ? t.dma50 : null,
    dma200: ok ? t.dma200 : null,
    ret1m: ok ? t.ret1m ?? null : null,
    ret6m: ok ? t.ret6m : null,
    fromHigh52wPct: ok && p && t.high52w ? round1(Math.max(0, ((t.high52w - p) / t.high52w) * 100)) : null,
    fromLow52wPct: ok && p && t.low52w ? round1(Math.max(0, ((p - t.low52w) / t.low52w) * 100)) : null,
    atr14: ok ? t.atr14 ?? null : null,
    news: classifyNews(i.news),
    newsItems: i.news,
    oi: i.oi,
    events: i.events,
    sector: i.sector,
  };
}

const TREND_LABEL: Record<TrendClass, string> = { STRONG_UP: 'Strong uptrend', UP: 'Uptrend', WEAK: 'Below 50-DMA', DOWN: 'Below 200-DMA', NO_DATA: 'No trend data' };

/** The UI's evidence chips, in a fixed order. */
export function evidenceChips(e: Evidence): EvidenceChip[] {
  const chips: EvidenceChip[] = [];
  chips.push({ label: TREND_LABEL[e.trend], tone: e.trend === 'STRONG_UP' || e.trend === 'UP' ? 'good' : e.trend === 'DOWN' ? 'bad' : e.trend === 'WEAK' ? 'neutral' : 'info' });
  if (e.ret6m !== null) chips.push({ label: `6m ${e.ret6m > 0 ? '+' : ''}${e.ret6m}%`, tone: e.ret6m > 0 ? 'good' : e.ret6m < 0 ? 'bad' : 'neutral' });
  if (e.momentum !== 'NO_DATA' && e.ret1m !== null) chips.push({ label: `1m ${e.ret1m > 0 ? '+' : ''}${e.ret1m}%`, tone: e.momentum === 'POSITIVE' ? 'good' : e.momentum === 'NEGATIVE' ? 'bad' : 'neutral' });
  if (e.fromHigh52wPct !== null) chips.push({ label: `${e.fromHigh52wPct}% below 52w high`, tone: e.fromHigh52wPct <= 10 ? 'good' : e.fromHigh52wPct >= 30 ? 'bad' : 'neutral' });
  if (e.oi.status !== 'NOT_FNO') {
    const b = e.oi.buildup ? e.oi.buildup.replace(/_/g, ' ').toLowerCase() : 'no OI data';
    chips.push({ label: `F&O OI: ${b}`, tone: e.oi.status === 'SUPPORTIVE' ? 'good' : e.oi.status === 'ADVERSE' ? 'bad' : e.oi.status === 'NO_DATA' ? 'info' : 'neutral' });
  }
  if (e.news !== 'NONE') chips.push({ label: `News ${e.news.toLowerCase()} (${e.newsItems.length})`, tone: e.news === 'POSITIVE' ? 'good' : e.news === 'NEGATIVE' ? 'bad' : 'neutral' });
  for (const ev of e.events.slice(0, 2)) chips.push({ label: `${ev.kind.replace(/_/g, ' ')} ${ev.at.slice(0, 10)}`, tone: 'info' });
  return chips;
}
