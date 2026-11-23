import { baseSymbol } from '../../news-events/keys';
import { underlyingName } from '../../night-report/domain/night-report.logic';
import type { AffectedItem } from './news-ai.validate';
import type { Direction } from './news-ai.schemas';

/** An article waiting for its AI read. */
export interface ArticleForRead {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  category: string;
  publishedAt: Date;
  relatedSymbols: string[];
  instruments: string[];
  sectors: string[];
  indices: string[];
  markets: string[];
  /** Failed attempts so far (0 = never tried). */
  attempts: number;
}

/** An article joined to its stored AI read (input to the brief and the overview). */
export interface ReadArticle {
  id: string;
  title: string;
  source: string;
  publishedAt: Date;
  direction: Direction;
  strength: number;
  importance: number;
  takeaway: string;
  affected: AffectedItem[];
  readAt: Date;
}

/** One open trade_trackers row of the owner (holding or position). */
export interface OwnerHolding {
  symbol: string;
  exchange: string;
  kind: string;
  qty: number;
  pnl: number | null;
}

const IST_OFFSET_MS = 330 * 60_000;
const HOUR = 3_600_000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : '-');

export function istStamp(d: Date): string {
  return `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
}

export function buildReadMessage(a: ArticleForRead): string {
  return [
    `Title: ${cut(a.title.trim(), 400)}`,
    `Summary: ${a.summary?.trim() ? cut(a.summary.trim(), 3000) : '(none)'}`,
    `Source: ${a.source} | category: ${a.category}`,
    `Published: ${istStamp(a.publishedAt)}`,
    `Existing tags (keyword tagger, may be wrong): symbols [${list([...new Set([...a.instruments, ...a.relatedSymbols])])}], ` +
      `sectors [${list(a.sectors)}], indices [${list(a.indices)}], markets [${list(a.markets)}]`,
  ].join('\n');
}

/** The name a holding is talked about by in the news: the underlying of a derivative, else the cash symbol. */
export function holdingName(h: Pick<OwnerHolding, 'symbol' | 'exchange'>): string {
  return underlyingName(h.symbol, h.exchange) ?? baseSymbol(h.symbol);
}

export interface BriefSelection {
  articles: ReadArticle[];
  windowFrom: Date;
  windowTo: Date;
}

/**
 * Which AI-read articles the brief sees.
 *  - Window: the last 6 h; when fewer than `minRecent` reads fall in it, widened to 24 h.
 *  - Order: importance desc, then strength desc, then newest.
 *  - Cap: `max` articles, of which up to a quarter are RESERVED for articles that touch an owner
 *    holding (affected name = the holding's underlying) so a quiet story on a held name is not crowded out.
 */
export function selectBriefArticles(
  reads: readonly ReadArticle[],
  holdings: readonly OwnerHolding[],
  now: Date,
  opts: { max: number; minRecent: number },
): BriefSelection {
  const t = now.getTime();
  const in24 = reads.filter((r) => r.publishedAt.getTime() >= t - 24 * HOUR && r.publishedAt.getTime() <= t + 5 * 60_000);
  const in6 = in24.filter((r) => r.publishedAt.getTime() >= t - 6 * HOUR);
  const wide = in6.length < opts.minRecent;
  const pool = wide ? in24 : in6;
  const rank = (a: ReadArticle, b: ReadArticle) =>
    b.importance - a.importance || b.strength - a.strength || b.publishedAt.getTime() - a.publishedAt.getTime();
  const sorted = [...pool].sort(rank);

  const held = new Set(holdings.map(holdingName));
  const touchesHolding = (r: ReadArticle) => r.affected.some((x) => held.has(x.name));
  const reserve = Math.min(Math.floor(opts.max / 4), sorted.filter(touchesHolding).length);
  const top = sorted.slice(0, Math.max(0, opts.max - reserve));
  const chosen = new Set(top.map((r) => r.id));
  const extra = sorted.filter((r) => !chosen.has(r.id) && touchesHolding(r)).slice(0, reserve);
  const fill = sorted.filter((r) => !chosen.has(r.id) && !extra.includes(r)).slice(0, Math.max(0, opts.max - top.length - extra.length));
  const articles = [...top, ...extra, ...fill].sort(rank);
  return { articles, windowFrom: new Date(t - (wide ? 24 : 6) * HOUR), windowTo: now };
}

export function buildBriefMessage(sel: BriefSelection, holdings: readonly OwnerHolding[], now: Date): string {
  const hold = holdings.length
    ? holdings
        .map((h) => `- ${h.symbol} (${h.exchange}, ${h.kind}, qty ${h.qty}${h.pnl != null ? `, P&L ${Math.round(h.pnl)}` : ''}) -> news name ${holdingName(h)}`)
        .join('\n')
    : '(no open holdings or positions)';
  const arts = sel.articles
    .map((a) => {
      const aff = a.affected.length ? a.affected.map((x) => `${x.kind}:${x.name} ${x.direction}`).join('; ') : '-';
      return [
        `[${a.id}] ${istStamp(a.publishedAt)} | ${a.source} | ${a.direction} strength ${a.strength} importance ${a.importance}`,
        `  ${cut(a.title.trim(), 300)}`,
        `  takeaway: ${a.takeaway}`,
        `  affected: ${aff}`,
      ].join('\n');
    })
    .join('\n');
  return [
    `Now: ${istStamp(now)}. News window: ${istStamp(sel.windowFrom)} to ${istStamp(sel.windowTo)}.`,
    '',
    'Open holdings and positions:',
    hold,
    '',
    `Articles (${sel.articles.length}, most important first; cite the id in brackets):`,
    arts || '(none)',
  ].join('\n');
}

/** Brief cadence: weekdays (Mon-Fri) 08:00-23:30 IST. */
export function briefWindowOpen(now: Date): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 8 * 60 && mins <= 23 * 60 + 30;
}
