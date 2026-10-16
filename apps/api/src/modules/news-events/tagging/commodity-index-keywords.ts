import { firstHit, UNDERLYING_NEWS_ALIASES, type AliasPattern } from '../../news/services/underlying-news-aliases';
import { INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2 } from '../keys';

/**
 * v2 commodity + index keywords (spec §5.3). The v1 map is reused verbatim for the
 * seven keys it has; the rest are new, each guarded the way v1 guards its own.
 * Run on text whose company-name spans are already blanked (name consumption), so
 * "Hindustan Zinc" and "Senco Gold" never reach these patterns.
 */
const V2_EXTRA: Readonly<Record<string, readonly AliasPattern[]>> = {
  ZINC: [{ re: /\bzinc\b/gi, notBefore: /\bHindustan\s+$/i }],
  // Never the verb: only the metal's market phrases.
  LEAD: [{ re: /\bLME lead\b/gi }, { re: /\blead (?:prices?|futures|contracts?)\b/gi }],
  ALUMINIUM: [{ re: /\balumin(?:i)?um\b/gi }],
  NICKEL: [{ re: /\bnickel\b/gi, notAfter: /^-?plated\b/i }],
  COTTON: [{ re: /\bcotton (?:prices?|futures|candy|arrivals|output|crop)\b/gi }, { re: /\bkapas\b/gi }],
  MENTHAOIL: [{ re: /\bmentha(?: oil)?\b/gi }],
  FINNIFTY: [{ re: /\bFin\s?Nifty\b/gi }, { re: /\bNifty Financial Services\b/gi }],
  MIDCPNIFTY: [{ re: /\bNifty Midcap Select\b/gi }, { re: /\bMIDCPNIFTY\b/g }],
  NIFTYNXT50: [{ re: /\bNifty Next 50\b/gi }],
  SENSEX: [{ re: /\b(?:Sensex|SENSEX)\b/g, notAfter: /^\s?50\b/ }],
  SENSEX50: [{ re: /\b(?:Sensex|SENSEX)\s?50\b/g }],
  BANKEX: [{ re: /\b(?:Bankex|BANKEX)\b/g }],
};

const ALL: Readonly<Record<string, readonly AliasPattern[]>> = { ...UNDERLYING_NEWS_ALIASES, ...V2_EXTRA };
const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => ALL[k]).map((k) => [k, ALL[k]]));

export const COMMODITY_KEYWORDS_V2: Readonly<Record<string, readonly AliasPattern[]>> = pick(MCX_BENCHMARKS_V2);
export const INDEX_KEYWORDS_V2: Readonly<Record<string, readonly AliasPattern[]>> = pick(INDEX_UNDERLYINGS_V2);

function hits(text: string, table: Readonly<Record<string, readonly AliasPattern[]>>): string[] {
  const found: Array<{ key: string; at: number }> = [];
  for (const [key, patterns] of Object.entries(table)) {
    const at = patterns.map((p) => firstHit(text, p)).filter((i) => i >= 0);
    if (at.length > 0) found.push({ key, at: Math.min(...at) });
  }
  return found.sort((a, b) => a.at - b.at).map((h) => h.key);
}

/** The commodity benchmarks and index underlyings the text names, in order of first appearance. Pure. */
export function keywordTags(text: string): { commodities: string[]; indices: string[] } {
  if (!text || !text.trim()) return { commodities: [], indices: [] };
  return { commodities: hits(text, COMMODITY_KEYWORDS_V2), indices: hits(text, INDEX_KEYWORDS_V2) };
}
