/**
 * In-memory relevance ranking for symbol search — the "elastic" feel of Angel
 * One without an actual search-engine service (overkill for a few-thousand-symbol
 * master on a free tier).
 *
 * Ranking, high → low: exact symbol · symbol prefix · symbol substring · name
 * prefix · name substring · fuzzy subsequence (query letters appear in order,
 * gaps allowed — e.g. "HDBK" → HDFCBANK). All case-insensitive; the NSE series
 * suffix (-EQ/-BE/…) is stripped before matching so "REL" hits "RELIANCE-EQ".
 * Within a level, a SHORTER symbol scores higher. Non-matches score 0.
 */

const LEVEL = {
  EXACT: 1000,
  SYM_PREFIX: 800,
  SYM_SUBSTR: 500,
  NAME_PREFIX: 400,
  NAME_SUBSTR: 300,
  SYM_SUBSEQ: 200,
  NAME_SUBSEQ: 100,
} as const;

const SERIES_SUFFIX = /-(EQ|BE|BL|IV)$/;

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Match-quality score for one candidate. Higher is better; 0 = no match. Length
 * penalty keeps shorter symbols ahead within a level without ever crossing into
 * the next level (levels are ≥100 apart, the penalty is capped at 50).
 */
export function scoreSymbolMatch(query: string, symbol: string, name = ''): number {
  const q = String(query).trim().toUpperCase();
  if (!q) return 0;
  const bare = String(symbol).toUpperCase().replace(SERIES_SUFFIX, '');
  const nm = String(name).toUpperCase();
  const shorter = -Math.min(bare.length, 50); // tie-break toward shorter symbols

  if (bare === q) return LEVEL.EXACT;
  if (bare.startsWith(q)) return LEVEL.SYM_PREFIX + shorter;
  if (bare.includes(q)) return LEVEL.SYM_SUBSTR + shorter;
  if (nm.startsWith(q)) return LEVEL.NAME_PREFIX;
  if (nm.includes(q)) return LEVEL.NAME_SUBSTR;
  if (isSubsequence(q, bare)) return LEVEL.SYM_SUBSEQ + shorter;
  if (nm && isSubsequence(q, nm)) return LEVEL.NAME_SUBSEQ;
  return 0;
}

/**
 * Filter to matches, rank by relevance, take the top `limit`. Ties break toward
 * NSE, then the liquid -EQ series, then original order (stable).
 */
export function rankSymbolMatches<T extends { symbol?: string; name?: string; exch_seg?: string }>(
  query: string,
  candidates: T[],
  limit = 25,
): T[] {
  const scored: Array<{ c: T; s: number; idx: number }> = [];
  candidates.forEach((c, idx) => {
    let s = scoreSymbolMatch(query, c.symbol ?? '', c.name ?? '');
    if (s <= 0) return;
    if (c.exch_seg === 'NSE') s += 3; // prefer NSE on a tie (small: never crosses a level)
    if (String(c.symbol ?? '').toUpperCase().endsWith('-EQ')) s += 1;
    scored.push({ c, s, idx });
  });
  scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
  return scored.slice(0, limit).map((x) => x.c);
}
