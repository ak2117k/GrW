/**
 * News impact layer 1c (2026-10-24): is a cluster relevant to how the owner trades?
 *
 * Additive weights, capped at 1:
 *   held      1.0  — an underlying the owner holds (open trade_trackers)
 *   heavy     0.6  — a NIFTY / BANKNIFTY heavyweight
 *   index     0.5  — tagged with NIFTY / BANKNIFTY / FINNIFTY itself
 *   macro     0.5  — market-wide (crude, Fed / US rates, rupee, FII / DII flows, RBI, CPI / GDP, global indices, geopolitics)
 *   fno       0.4  — an F&O stock
 *   coverage  0.1  — three or more sources carry it
 * Relevant = score ≥ {@link RELEVANT_AT}. A non-F&O small cap's filing scores 0 and is never analysed.
 */

export const RELEVANT_AT = 0.4;

/** The heaviest NIFTY 50 / BANKNIFTY constituents (by index weight; a static list — refresh with the index). */
export const INDEX_HEAVYWEIGHTS: ReadonlySet<string> = new Set([
  'HDFCBANK', 'ICICIBANK', 'RELIANCE', 'INFY', 'BHARTIARTL', 'TCS', 'LT', 'ITC', 'SBIN', 'AXISBANK',
  'KOTAKBANK', 'M&M', 'HINDUNILVR', 'BAJFINANCE', 'SUNPHARMA', 'MARUTI', 'HCLTECH', 'NTPC', 'TATAMOTORS', 'ULTRACEMCO',
  'INDUSINDBK', 'BANKBARODA', 'PNB', 'AUBANK', 'FEDERALBNK', 'IDFCFIRSTB', 'CANBK',
]);

export const INDEX_TAGS: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'NIFTY 50', 'NIFTY BANK']);

/** Market-wide drivers. Word-bounded; tested on headline + summary. */
export const MACRO_RE =
  /\b(crude|brent|wti|opec|oil prices?|fed|fomc|powell|us (rates?|yields?|inflation|cpi|jobs|payrolls?)|treasury yields?|rate (cut|hike)s?|rupee|usd\s*\/?\s*inr|usdinr|forex reserves?|fii|fpi|dii|foreign (institutional|portfolio) investors?|rbi|repo rate|monetary policy|mpc|inflation|cpi|wpi|gdp|iip|fiscal deficit|budget|gst collections?|nasdaq|dow jones|s&p 500|nikkei|hang seng|wall street|global markets?|geopolitic\w*|war|ceasefire|sanctions?|tariffs?|missile|attack|china|trump)\b/i;

export interface RelevanceInput {
  instruments: readonly string[];
  indices: readonly string[];
  text: string;
  sourceCount: number;
}

export interface RelevanceContext {
  fno: ReadonlySet<string>;
  held: ReadonlySet<string>;
}

export interface Relevance {
  score: number;
  reasons: string[];
}

export function relevanceOf(c: RelevanceInput, ctx: RelevanceContext): Relevance {
  const reasons: string[] = [];
  let score = 0;
  const syms = [...new Set(c.instruments.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const held = syms.filter((s) => ctx.held.has(s));
  const idx = c.indices.map((s) => s.toUpperCase()).filter((s) => INDEX_TAGS.has(s));
  const heldIdx = idx.filter((s) => ctx.held.has(s === 'NIFTY BANK' ? 'BANKNIFTY' : s === 'NIFTY 50' ? 'NIFTY' : s));
  if (held.length || heldIdx.length) {
    score += 1;
    reasons.push(`held:${[...held, ...heldIdx].join(',')}`);
  }
  const heavy = syms.filter((s) => INDEX_HEAVYWEIGHTS.has(s));
  if (heavy.length) {
    score += 0.6;
    reasons.push(`heavyweight:${heavy.join(',')}`);
  }
  if (idx.length) {
    score += 0.5;
    reasons.push(`index:${idx.join(',')}`);
  }
  const macro = MACRO_RE.exec(c.text);
  if (macro) {
    score += 0.5;
    reasons.push(`macro:${macro[0].toLowerCase()}`);
  }
  const fno = syms.filter((s) => ctx.fno.has(s));
  if (fno.length) {
    score += 0.4;
    reasons.push(`fno:${fno.slice(0, 5).join(',')}`);
  }
  if (c.sourceCount >= 3) {
    score += 0.1;
    reasons.push(`coverage:${c.sourceCount}`);
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}
