import type { SessionClock } from '../../market-hub/session-clock';
import { INDEX_UNDERLYINGS, isDerivative } from '../../market-hub/underlying';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { lastSessionClose } from '../../trade-sentinel/overnight/overnight-calendar';
import { parseOptionSymbol } from '../../trade-sentinel/overnight/overnight-evidence';
import { baseSymbol, instrumentKeysOf, keysOfTags, MCX_GROUP, MCX_PARENT_V2, newsPositionOf } from '../../news-events/keys';
import type { MarketTag } from '../../news-events/types';
import type {
  JobStatus,
  NewsGroup,
  NewsItem,
  NewsSection,
  NightWindow,
  SymbolRef,
  VerdictView,
  VerdictWindow,
} from './night-report.types';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of IST midnight of `ymd`. */
export function istMidnightOf(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS);
}

// ─── Chart links ─────────────────────────────────────────────────────────────

/**
 * The web's chart deep link — the same string `buildChartHref` in
 * apps/web/src/utils/chartHref.ts produces: `/charts?symbol=…[&token=…]&exchange=…`.
 * The token is left out when unknown; the web resolves it from the symbol.
 */
export function chartHref(symbol: string, token: string | null, exchange: string): string {
  const params = new URLSearchParams();
  params.set('symbol', symbol);
  if (token) params.set('token', token);
  params.set('exchange', exchange || 'NSE');
  return `/charts?${params.toString()}`;
}

export function symbolRef(symbol: string, exchange: string, token: string | null): SymbolRef {
  const ex = exchange || 'NSE';
  return { symbol, exchange: ex, token: token || null, chartHref: chartHref(symbol, token || null, ex) };
}

// ─── Window ──────────────────────────────────────────────────────────────────

/**
 * The night being reported: last NSE close → now, and the next NSE open. When
 * the calendar cannot name a close (no holiday list), the night is the last 24h.
 */
export function nightWindow(now: Date, clock: SessionClock): NightWindow {
  const from = lastSessionClose('NSE', now, clock) ?? new Date(now.getTime() - DAY_MS);
  const today = istYmd(now);
  const holiday = (MARKET_HOLIDAYS[Number(today.slice(0, 4))] ?? []).find(
    (h) => h.date === today && (h.exchanges as readonly string[]).includes('NSE'),
  );
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    nextOpen: clock.nextOpen('NSE', now)?.toISOString() ?? null,
    holidayNote: holiday ? `Today is an NSE holiday (${holiday.name})` : null,
  };
}

/** The IST dates of the last `n` NSE sessions that have closed at or before `now`, newest first. */
export function lastSessionDates(now: Date, clock: SessionClock, n: number): string[] {
  const out: string[] = [];
  let at = now;
  for (let i = 0; i < n; i++) {
    const close = lastSessionClose('NSE', at, clock);
    if (!close) break;
    out.push(istYmd(close));
    at = new Date(istMidnightOf(istYmd(close)).getTime() - 1);
  }
  return out;
}

// ─── Underlying ──────────────────────────────────────────────────────────────

const FUTURE = /^([A-Z&-]+?)\d{2}[A-Z]{3}\d{2}FUT$/;

/**
 * The master-free underlying NAME of a derivative tradingsymbol
 * (`NIFTY13OCT2625000CE` → NIFTY, `CRUDEOIL19NOV26FUT` → CRUDEOIL); null for
 * cash or a spelling this does not recognise.
 */
export function underlyingName(symbol: string, exchange: string): string | null {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!isDerivative({ exchange, symbol: sym })) return null;
  return parseOptionSymbol(sym)?.underlying ?? FUTURE.exec(sym)?.[1] ?? null;
}

/** A chart target for an underlying name. `cashToken` is the NSE cash token when the caller looked it up. */
export function underlyingRef(name: string, exchange: string, cashToken: string | null): SymbolRef {
  const idx = INDEX_UNDERLYINGS[name];
  if (idx) return symbolRef(name, idx.exchange, idx.token);
  if (String(exchange).toUpperCase() === 'MCX') return symbolRef(name, 'MCX', null);
  return symbolRef(name, 'NSE', cashToken);
}

/** A chart target for a news tag / setup key (an instrument, a commodity or an index). */
export function tagRef(key: string): SymbolRef {
  const k = key.trim().toUpperCase();
  const idx = INDEX_UNDERLYINGS[k];
  if (idx) return symbolRef(k, idx.exchange, idx.token);
  if (MCX_GROUP[MCX_PARENT_V2[k] ?? k]) return symbolRef(k, 'MCX', null);
  return symbolRef(k, 'NSE', null);
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

/**
 * Split an overnight verdict's reason into the risk and the open plan. A port of
 * `parseOvernightReason` in apps/web/src/components/charts/overnightPlanView.ts
 * (the API cannot import web code); keep the two in step. Never invents a plan.
 */
export function parseOvernightReason(reason: string): { risk: string; plan: string | null } {
  const text = String(reason ?? '');
  const oneLine = (t: string) => t.replace(/\s*\r?\n\s*/g, ' ').trim();
  const at = text.indexOf('OPEN PLAN:');
  const head = at >= 0 ? text.slice(0, at) : text;
  const plan = at >= 0 ? oneLine(text.slice(at + 'OPEN PLAN:'.length)) || null : null;
  const hasRiskLabel = head.includes('OVERNIGHT RISK:');
  if (!hasRiskLabel && at < 0) return { risk: oneLine(text), plan: null };
  const risk = oneLine(hasRiskLabel ? head.slice(head.indexOf('OVERNIGHT RISK:') + 'OVERNIGHT RISK:'.length) : head);
  return { risk, plan };
}

export const OVERNIGHT_VERDICTS: ReadonlySet<string> = new Set(['HOLD_OVERNIGHT', 'EXIT_AT_OPEN', 'TIGHTEN_AT_OPEN']);

export interface VerdictRow {
  trackerId: string;
  verdict: string;
  confidence: string | null;
  reason: string;
  invalidationPoint: string | null;
  triggeredBy: unknown;
  createdAt: Date;
}

/** Which review wrote the row, from the window kind stored in `triggeredBy`. */
export function verdictWindow(triggeredBy: unknown): VerdictWindow {
  const tags = Array.isArray(triggeredBy) ? triggeredBy.map((t) => String(t)) : [];
  if (tags.includes('OVERNIGHT_REVIEW')) return 'OVERNIGHT_REVIEW';
  if (tags.includes('PRE_OPEN_CHECK')) return 'PRE_OPEN_CHECK';
  if (tags.includes('PRE_OPEN_REVIEW')) return 'PRE_OPEN_REVIEW';
  return 'LIVE';
}

function toView(r: VerdictRow, window: VerdictWindow): VerdictView {
  const { risk, plan } =
    window === 'LIVE' ? { risk: String(r.reason ?? '').trim(), plan: null } : parseOvernightReason(r.reason);
  return {
    verdict: r.verdict,
    confidence: r.confidence ?? null,
    risk,
    plan,
    invalidation: r.invalidationPoint && r.invalidationPoint.trim() ? r.invalidationPoint.trim() : null,
    at: r.createdAt.toISOString(),
    window,
  };
}

export interface PickedVerdicts {
  overnight: VerdictView | null;
  preOpen: VerdictView | null;
  live: VerdictView | null;
}

/**
 * The latest after-close verdict (an overnight verdict value only), the latest
 * pre-open one (review or 09:10 check, same values) and the latest live one,
 * from any mix of one tracker's rows in any order.
 */
export function pickVerdicts(rows: readonly VerdictRow[]): PickedVerdicts {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const out: PickedVerdicts = { overnight: null, preOpen: null, live: null };
  for (const r of sorted) {
    const w = verdictWindow(r.triggeredBy);
    if (w === 'OVERNIGHT_REVIEW') {
      if (!out.overnight && OVERNIGHT_VERDICTS.has(r.verdict)) out.overnight = toView(r, w);
    } else if (w === 'PRE_OPEN_REVIEW' || w === 'PRE_OPEN_CHECK') {
      if (!out.preOpen && OVERNIGHT_VERDICTS.has(r.verdict)) out.preOpen = toView(r, w);
    } else if (!out.live) {
      out.live = toView(r, w);
    }
  }
  return out;
}

/** The plan in force for the open: the pre-open read when it is newer than the after-close one. */
export function planInForce(p: { overnight: VerdictView | null; preOpen: VerdictView | null }): VerdictView | null {
  if (p.preOpen && (!p.overnight || p.preOpen.at >= p.overnight.at)) return p.preOpen;
  return p.overnight;
}

/** AI_AUTO_EXIT_HOLD matching, as the executor's guard does: upper-cased symbol or tracker id. */
export function isHeld(hold: readonly string[], t: { id: string; symbol: string }): boolean {
  if (hold.length === 0) return false;
  return [t.symbol, t.id].map((k) => String(k ?? '').trim().toUpperCase()).filter(Boolean).some((k) => hold.includes(k));
}

// ─── News ────────────────────────────────────────────────────────────────────

export interface NewsRow {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  url: string;
  category: string;
  sentiment: string | null;
  sentimentScore: number | null;
  relatedSymbols: string[];
  instruments: string[];
  sectors: string[];
  indices: string[];
  markets: string[];
  publishedAt: Date;
}

/** A held underlying as the news and events matchers see it. */
export interface HeldKey {
  /** The underlying name, or the cash symbol's base. */
  label: string;
  exchange: string;
  /** What a group / event chip links to. */
  ref: SymbolRef;
}

const MARKETS: ReadonlySet<string> = new Set<MarketTag>(['IN', 'GLOBAL']);
const MARKET_CATEGORIES: ReadonlySet<string> = new Set(['indian', 'global', 'sector']);
const MAX_SYMBOLS = 6;

/** The news-index keys a held position is matched on (`I:KEI`, `X:NIFTY`, `I:CRUDEOIL`). */
export function heldNewsKeys(h: Pick<HeldKey, 'label' | 'exchange'>): string[] {
  const p = newsPositionOf(h.label, h.exchange, null);
  return 'unresolved' in p ? [] : instrumentKeysOf(p);
}

/** Every key an article carries: its v2 tags plus the legacy `relatedSymbols` as instruments. */
export function articleKeys(a: NewsRow): Set<string> {
  const keys = keysOfTags({
    instruments: a.instruments ?? [],
    sectors: a.sectors ?? [],
    indices: a.indices ?? [],
    markets: (a.markets ?? []).filter((m): m is MarketTag => MARKETS.has(m)),
  });
  for (const s of a.relatedSymbols ?? []) keys.push(`I:${baseSymbol(s)}`);
  return new Set(keys);
}

function isMarketLevel(a: NewsRow): boolean {
  return (
    (a.indices?.length ?? 0) > 0 ||
    (a.sectors?.length ?? 0) > 0 ||
    (a.markets ?? []).some((m) => MARKETS.has(m)) ||
    MARKET_CATEGORIES.has(String(a.category ?? '').toLowerCase())
  );
}

function toNewsItem(a: NewsRow): NewsItem {
  const keys = [...(a.instruments ?? []), ...(a.relatedSymbols ?? []).map(baseSymbol), ...(a.indices ?? [])]
    .map((k) => String(k).trim().toUpperCase())
    .filter(Boolean);
  return {
    id: a.id,
    title: a.title,
    summary: a.summary,
    source: a.source,
    url: a.url,
    publishedAt: a.publishedAt.toISOString(),
    sentiment: a.sentiment,
    sentimentScore: a.sentimentScore,
    symbols: [...new Set(keys)].slice(0, MAX_SYMBOLS).map(tagRef),
  };
}

/**
 * Split the window's articles into "on your positions", grouped per held
 * underlying (matched on the news-events key scheme: an article lands in every
 * group it touches), and "market" (index, sector or macro tagged, the
 * `marketLimit` newest that touched no position). Newest first throughout.
 */
export function splitNews(rows: readonly NewsRow[], held: readonly HeldKey[], marketLimit = 20): NewsSection {
  const byKey = new Map<string, HeldKey[]>();
  for (const h of held) {
    for (const k of heldNewsKeys(h)) byKey.set(k, [...(byKey.get(k) ?? []), h]);
  }
  const groups = new Map<string, NewsGroup>();
  const market: NewsItem[] = [];
  const sorted = [...rows].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  for (const a of sorted) {
    const hits = new Set<HeldKey>();
    for (const k of articleKeys(a)) for (const h of byKey.get(k) ?? []) hits.add(h);
    if (hits.size > 0) {
      const item = toNewsItem(a);
      for (const h of hits) {
        if (!groups.has(h.label)) groups.set(h.label, { symbol: h.ref, items: [] });
        groups.get(h.label)!.items.push(item);
      }
    } else if (market.length < marketLimit && isMarketLevel(a)) {
      market.push(toNewsItem(a));
    }
  }
  const onPositions = [...groups.values()].sort(
    (x, y) => y.items.length - x.items.length || x.symbol.symbol.localeCompare(y.symbol.symbol),
  );
  return { onPositions, market };
}

/** Distinct articles across the groups (one article can sit under two symbols). */
export function distinctArticles(groups: readonly NewsGroup[]): number {
  return new Set(groups.flatMap((g) => g.items.map((i) => i.id))).size;
}

// ─── Freshness ───────────────────────────────────────────────────────────────

/** ok when `at` is at or after `okSince`, stale when older, missing when absent. */
export function freshness(at: Date | null, okSince: Date): JobStatus {
  if (!at) return 'missing';
  return at.getTime() >= okSince.getTime() ? 'ok' : 'stale';
}
