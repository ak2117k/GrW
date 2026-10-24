/**
 * News impact layer 2 (2026-10-24): which clusters go to the cheap model, the batched prompt, the
 * strict reply schema and its validation, impact → article sentiment, ranking, and the high-impact
 * targets. Pure — the service does the I/O.
 */
import type { MaterialType } from './announcement-classifier';
import { NSE_ANNOUNCEMENTS } from './announcement-classifier';
import { RELEVANT_AT } from './relevance';

export const DIRECTIONS = ['BULL', 'BEAR', 'NEUTRAL'] as const;
export const MAGNITUDES = ['LOW', 'MED', 'HIGH'] as const;
export const HORIZONS = ['INTRADAY', 'DAYS', 'WEEKS'] as const;
export const IMPACT_INDICES = ['NIFTY', 'BANKNIFTY'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type Magnitude = (typeof MAGNITUDES)[number];
export type Horizon = (typeof HORIZONS)[number];
export type ImpactIndex = (typeof IMPACT_INDICES)[number];

/** Clusters per model call (one call per run). */
export const BATCH_CAP = 30;
/** A cluster older than this (by lastSeen) is never sent: the window for a fresh read has passed. */
export const ANALYSE_WITHIN_MS = 24 * 3_600_000;
/** A cluster the model skipped / answered invalidly this many times is not sent again. */
export const MAX_ATTEMPTS = 2;
const HEADLINE_MAX = 200;
const SUMMARY_MAX = 280;
const EXTRA_TITLES = 2;

export interface ClusterForImpact {
  id: string;
  headline: string;
  instruments: string[];
  sectors: string[];
  indices: string[];
  sources: string[];
  sourceCount: number;
  firstSeen: Date;
  lastSeen: Date;
  materialType: MaterialType | string;
  material: boolean;
  boilerplate: boolean;
  relevance: number;
  reasons: string[];
  impactAttempts: number;
  /** The source count when last analysed; null = never analysed. */
  analysedSourceCount: number | null;
}

/**
 * Eligible for the model: not boilerplate; relevant; an NSE-filing-only cluster must be a MATERIAL
 * type; fresh (lastSeen within 24 h); never analysed (or its coverage has since doubled); not given up on.
 */
export function eligible(c: ClusterForImpact, now: Date): boolean {
  if (c.boilerplate || c.relevance < RELEVANT_AT) return false;
  const nseOnly = c.sources.length > 0 && c.sources.every((s) => s === NSE_ANNOUNCEMENTS);
  if (nseOnly && !c.material) return false;
  if (now.getTime() - c.lastSeen.getTime() > ANALYSE_WITHIN_MS) return false;
  if (c.analysedSourceCount !== null) return c.sourceCount >= 2 * Math.max(1, c.analysedSourceCount);
  return c.impactAttempts < MAX_ATTEMPTS;
}

/** Up to `cap` eligible clusters: most relevant first, then widest coverage, then newest. */
export function pickBatch(clusters: readonly ClusterForImpact[], now: Date, cap = BATCH_CAP): ClusterForImpact[] {
  return clusters
    .filter((c) => eligible(c, now))
    .sort((a, b) => b.relevance - a.relevance || b.sourceCount - a.sourceCount || b.lastSeen.getTime() - a.lastSeen.getTime())
    .slice(0, cap);
}

export const NEWS_IMPACT_SYSTEM = `You are a markets desk analyst for an Indian F&O trader (NIFTY / BANKNIFTY options, F&O stocks, MCX).
For EACH news story you are given, judge its likely price impact. Be conservative: most news is NEUTRAL or LOW.
- direction: BULL / BEAR / NEUTRAL for the affected instruments (for a market-wide story, for the Indian index).
- magnitude: LOW (noise, < 0.5 ATR), MED (a noticeable move), HIGH (a gap / trend-changing move; rare — results surprises, big orders vs market cap, M&A, regulatory bans, RBI / Fed surprises, war).
- horizon: INTRADAY (fades today), DAYS, WEEKS.
- affected.symbols: NSE symbols directly affected (upper case, ≤ 5); affected.sectors: sector names; affected.index: NIFTY, BANKNIFTY or null.
- pricedIn: true when the story is old, widely expected, or a recap of a move that already happened.
- confidence: 0..1. oneLine: ≤ 20 words, what it means for price.
Use only the text given. Answer every clusterId exactly once. Strict JSON only.`;

export const NEWS_IMPACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['clusterId', 'direction', 'magnitude', 'horizon', 'affected', 'pricedIn', 'confidence', 'oneLine'],
        properties: {
          clusterId: { type: 'string' },
          direction: { type: 'string', enum: [...DIRECTIONS] },
          magnitude: { type: 'string', enum: [...MAGNITUDES] },
          horizon: { type: 'string', enum: [...HORIZONS] },
          affected: {
            type: 'object',
            additionalProperties: false,
            required: ['symbols', 'sectors', 'index'],
            properties: {
              symbols: { type: 'array', items: { type: 'string' } },
              sectors: { type: 'array', items: { type: 'string' } },
              index: { anyOf: [{ type: 'string', enum: [...IMPACT_INDICES] }, { type: 'null' }] },
            },
          },
          pricedIn: { type: 'boolean' },
          confidence: { type: 'number' },
          oneLine: { type: 'string' },
        },
      },
    },
  },
} as const;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const istStamp = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** One line-oriented block per cluster: headline + ≤ 2 other titles + one truncated summary. Never a full article body. */
export function buildImpactUserMessage(
  batch: ReadonlyArray<ClusterForImpact & { titles?: string[]; summary?: string | null }>,
): string {
  const blocks = batch.map((c) => {
    const lines = [
      `clusterId: ${c.id}`,
      `headline: ${cut(c.headline.replace(/\s+/g, ' '), HEADLINE_MAX)}`,
      ...(c.titles ?? [])
        .filter((t) => t !== c.headline)
        .slice(0, EXTRA_TITLES)
        .map((t) => `also: ${cut(t.replace(/\s+/g, ' '), HEADLINE_MAX)}`),
      ...(c.summary ? [`summary: ${cut(c.summary.replace(/\s+/g, ' '), SUMMARY_MAX)}`] : []),
      `type: ${c.materialType}; sources: ${c.sourceCount} (${c.sources.slice(0, 4).join(', ')}); first seen ${istStamp(c.firstSeen)} IST`,
      `tags: instruments=[${c.instruments.slice(0, 8).join(', ')}] sectors=[${c.sectors.slice(0, 4).join(', ')}] indices=[${c.indices.join(', ')}]`,
    ];
    return lines.join('\n');
  });
  return `${batch.length} stories. Return {"items":[…]} with one item per clusterId.\n\n${blocks.join('\n\n')}`;
}

export interface ImpactItem {
  clusterId: string;
  direction: Direction;
  magnitude: Magnitude;
  horizon: Horizon;
  affected: { symbols: string[]; sectors: string[]; index: ImpactIndex | null };
  pricedIn: boolean;
  confidence: number;
  oneLine: string;
}

const isIn = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);

/**
 * Keep only well-formed items for clusters in this batch, once each. Confidence 0..1 (a 0..100
 * answer is rescaled); symbols upper-cased, ≤ 5; oneLine ≤ 200 chars. Anything else is dropped.
 */
export function validateImpactReply(reply: unknown, batchIds: readonly string[]): ImpactItem[] {
  const items = (reply as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const want = new Set(batchIds);
  const seen = new Set<string>();
  const out: ImpactItem[] = [];
  for (const raw of items) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.clusterId === 'string' ? r.clusterId.trim() : '';
    if (!want.has(id) || seen.has(id)) continue;
    if (!isIn(DIRECTIONS, r.direction) || !isIn(MAGNITUDES, r.magnitude) || !isIn(HORIZONS, r.horizon)) continue;
    const aff = (r.affected ?? {}) as Record<string, unknown>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
    const index = aff.index === null || aff.index === undefined ? null : isIn(IMPACT_INDICES, aff.index) ? aff.index : undefined;
    if (index === undefined) continue;
    let conf = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : NaN;
    if (conf > 1 && conf <= 100) conf /= 100;
    if (!(conf >= 0 && conf <= 1)) continue;
    if (typeof r.pricedIn !== 'boolean' || typeof r.oneLine !== 'string' || !r.oneLine.trim()) continue;
    seen.add(id);
    out.push({
      clusterId: id,
      direction: r.direction,
      magnitude: r.magnitude,
      horizon: r.horizon,
      affected: {
        symbols: [...new Set(strs(aff.symbols).map((s) => s.toUpperCase()))].slice(0, 5),
        sectors: [...new Set(strs(aff.sectors))].slice(0, 5),
        index,
      },
      pricedIn: r.pricedIn,
      confidence: Math.round(conf * 100) / 100,
      oneLine: cut(r.oneLine.trim(), 200),
    });
  }
  return out;
}

export const MAGNITUDE_WEIGHT: Readonly<Record<Magnitude, number>> = { LOW: 0.3, MED: 0.6, HIGH: 0.9 };

/** The article sentiment an impact implies (replaces the keyword guess once the model has read the story). */
export function impactSentiment(i: Pick<ImpactItem, 'direction' | 'magnitude' | 'confidence' | 'pricedIn'>): {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  score: number;
} {
  if (i.direction === 'NEUTRAL') return { sentiment: 'neutral', score: 0 };
  const sign = i.direction === 'BULL' ? 1 : -1;
  const damp = i.pricedIn ? 0.5 : 1;
  const score = Math.round(sign * MAGNITUDE_WEIGHT[i.magnitude] * Math.max(0.3, i.confidence) * damp * 100) / 100;
  return { sentiment: sign > 0 ? 'bullish' : 'bearish', score };
}

/** Rank for ideas and the digest: magnitude × relevance × coverage (log-ish), NEUTRAL / priced-in discounted. */
export function impactRank(i: { magnitude: string; direction: string; pricedIn: boolean; confidence: number }, relevance: number, sourceCount: number): number {
  const m = MAGNITUDE_WEIGHT[i.magnitude as Magnitude] ?? 0.3;
  const dir = i.direction === 'NEUTRAL' ? 0.3 : 1;
  const priced = i.pricedIn ? 0.5 : 1;
  const coverage = 1 + Math.log2(Math.max(1, sourceCount)) / 2;
  return Math.round(m * Math.max(0.1, relevance) * coverage * dir * priced * Math.max(0.3, i.confidence) * 1000) / 1000;
}

/**
 * Whom a HIGH impact concerns: the affected symbols the owner (or any open position) holds, plus the
 * index when it is NIFTY / BANKNIFTY. Empty ⇒ no wake, no alert. Upper-case names.
 */
export function highImpactTargets(
  i: Pick<ImpactItem, 'magnitude' | 'affected'>,
  held: ReadonlySet<string>,
): string[] {
  if (i.magnitude !== 'HIGH') return [];
  const out = new Set<string>();
  for (const s of i.affected.symbols) if (held.has(s)) out.add(s);
  if (i.affected.index) out.add(i.affected.index);
  return [...out];
}

/**
 * Cadence: every 15 min 09:00–15:45 IST on an NSE trading day; every 2 h otherwise (measured from
 * the last run). `istMin` is minutes after IST midnight.
 */
export function impactRunDue(now: Date, istMin: number, tradingDay: boolean, lastRunAt: Date | null): boolean {
  const inSession = tradingDay && istMin >= 9 * 60 && istMin <= 15 * 60 + 45;
  if (inSession) return true;
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= 2 * 3_600_000 - 60_000;
}
