import { extractSymbols } from '../../news/services/extract-symbols';
import { MCX_GROUP } from '../keys';
import type { ArticleTags, SectorLookup } from '../types';
import { keywordTags } from './commodity-index-keywords';
import { FEED_SECTOR, marketTags, sectorPhraseTags } from './market-sector-rules';
import { blankSpans, type NameMatcher } from './name-matcher';

export interface TagInput { title: string; summary: string; source: string; category: string; forceInstrument?: string }
export interface TagContext { matcher: NameMatcher; listed: ReadonlySet<string>; sectors: SectorLookup }

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

/**
 * Spec §5: the four tag sets, computed ONCE at ingestion. Pure.
 * Company names are matched first and their spans blanked, so "Senco Gold" is never
 * GOLD and "Hindustan Zinc" never ZINC; tickers, keywords, sector phrases and market
 * keywords then read the remaining text.
 */
export function tagArticle(a: TagInput, ctx: TagContext): ArticleTags {
  const text = `${a.title ?? ''} ${a.summary ?? ''}`;
  const names = ctx.matcher.match(text);
  const rest = blankSpans(text, names.spans);
  const tickers = extractSymbols(a.title, a.summary, ctx.listed);
  const kw = keywordTags(rest);
  const companies = uniq([a.forceInstrument, ...names.symbols, ...tickers]);
  return {
    instruments: uniq([...companies, ...kw.commodities]),
    sectors: uniq([
      ...companies.map((s) => ctx.sectors.sectorOf(s)),
      ...(FEED_SECTOR[a.source] ?? []),
      ...sectorPhraseTags(rest),
      ...kw.commodities.map((c) => MCX_GROUP[c]),
    ]),
    indices: kw.indices,
    markets: marketTags(a.category, rest),
  };
}
