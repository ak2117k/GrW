/**
 * News for underlyings that are NOT listed companies: MCX commodities and the
 * NFO indices. Pure — no imports — so the sentinel can use it without pulling
 * the news module's database or HTTP into its import graph.
 *
 * WHY THIS EXISTS. `extractSymbols` tags an article only with symbols from the
 * NSE/BSE cash instrument table, and GOLD and OIL are on its ambiguous list
 * (they are listed tickers that mostly mean the commodity). So CRUDEOIL,
 * NATURALGAS, BANKNIFTY and friends could never be a `relatedSymbol`, and the
 * sentinel's news blocks on every MCX and index position were permanently
 * empty — reported to the agent as "0 fresh headlines", a claim about the
 * market that was really a claim about our tagger.
 *
 * CONSERVATIVE BY CONSTRUCTION. Each alias is a phrase that, in financial copy,
 * almost always means the benchmark — "crude", "Brent", "bullion", "Henry Hub".
 * The phrases that routinely do NOT mean it are rejected by context, each one
 * tested: crude PALM oil and crude STEEL, gold LOANS and gold MEDALS, a silver
 * LINING and Silver LAKE, PETRONET LNG the company, the sectoral Nifty indices.
 * A false tag makes `newsHit` fire on noise, which teaches the agent to
 * discount it — worse than no tag at all.
 */

export interface AliasPattern {
  /** Global regex; case-sensitivity is part of the rule (Nifty vs "nifty"). */
  re: RegExp;
  /** Rejects the match when the text BEFORE it matches (anchored at its end). */
  notBefore?: RegExp;
  /** Rejects the match when the text AFTER it matches (anchored at its start). */
  notAfter?: RegExp;
}

const NIFTY_SECTORAL =
  /^\s+(?:bank|it|midcap\w*|smallcap\w*|microcap\w*|largemidcap\w*|next|auto|pharma|metal|fmcg|realty|psu|media|energy|fin\w*|private|oil|healthcare|consumer|infra\w*|india|cpse|commodities|mnc|services|defence|total|alpha|quality|value|momentum|dividend|housing|mobility|digital|ev|tourism|manufacturing|capital|chemicals|100|200|500)\b/i;

/**
 * Underlying key → the phrases that tag an article with it. The key is the
 * MCX/NFO underlying NAME (as on the instrument master), which is also what
 * `relatedSymbols` stores and what the sentinel looks up.
 */
export const UNDERLYING_NEWS_ALIASES: Readonly<Record<string, readonly AliasPattern[]>> = {
  CRUDEOIL: [
    { re: /\bcrude\b/gi, notAfter: /^\s+(?:palm|steel|soy\w*|sunflower|edible|degummed|rapeseed|vegetable)\b/i },
    { re: /\bBrent\b/g },
    { re: /\bWTI\b/g },
    { re: /\bOPEC\b/g },
    { re: /\boil prices?\b/gi, notBefore: /\b(?:edible|palm|cooking|vegetable|mustard|soy\w*|sunflower|groundnut)\s+$/i },
  ],
  GOLD: [
    { re: /\bgold\b/gi, notAfter: /^\s+(?:loans?|medal\w*|card|standard)\b/i },
    { re: /\bbullion\b/gi },
  ],
  SILVER: [{ re: /\bsilver\b/gi, notAfter: /^\s+(?:lining|jubilee|medal\w*|screen|lake)\b/i }],
  NATURALGAS: [
    { re: /\bnatural gas\b/gi },
    { re: /\bHenry Hub\b/gi },
    { re: /\bLNG\b/g, notBefore: /\bPetronet\s+$/i },
  ],
  COPPER: [{ re: /\bcopper\b/gi }],
  BANKNIFTY: [{ re: /\bBank\s?Nifty\b/gi }, { re: /\bNifty\s+Bank\b/gi }],
  NIFTY: [
    // Case-SENSITIVE: lowercase "nifty" is an English adjective.
    { re: /\b(?:Nifty|NIFTY)(?:\s?50)?\b/g, notBefore: /\b(?:bank|fin)\s?$/i, notAfter: NIFTY_SECTORAL },
  ],
};

/** MCX mini / micro contracts → the benchmark the headlines talk about. */
const PARENT: Readonly<Record<string, string>> = {
  CRUDEOILM: 'CRUDEOIL',
  GOLDM: 'GOLD',
  GOLDGUINEA: 'GOLD',
  GOLDPETAL: 'GOLD',
  GOLDTEN: 'GOLD',
  SILVERM: 'SILVER',
  SILVERMIC: 'SILVER',
  SILVER1000: 'SILVER',
  NATGASMINI: 'NATURALGAS',
};

/** Index underlyings that are not listed companies — taggable only through an alias. */
const INDEX_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50']);

export function firstHit(text: string, p: AliasPattern): number {
  const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (p.notBefore && p.notBefore.test(before)) continue;
    if (p.notAfter && p.notAfter.test(after)) continue;
    return m.index;
  }
  return -1;
}

/**
 * The commodity / index underlyings this article is about, de-duplicated, in
 * the order they first appear. Pure.
 */
export function aliasSymbols(title: string, summary: string): string[] {
  const text = `${title ?? ''} ${summary ?? ''}`;
  if (!text.trim()) return [];
  const hits: Array<{ key: string; at: number }> = [];
  for (const [key, patterns] of Object.entries(UNDERLYING_NEWS_ALIASES)) {
    const at = patterns.map((p) => firstHit(text, p)).filter((i) => i >= 0);
    if (at.length > 0) hits.push({ key, at: Math.min(...at) });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.key);
}

export type NewsKey = { key: string } | { key: null; reason: string };

/**
 * The `relatedSymbols` key a position's underlying is looked up by — or null
 * WITH THE REASON when no article can ever be tagged with it. The caller must
 * then report the news blocks unavailable: a lookup that can only ever return
 * nothing would otherwise reach the agent as "no headlines", a false fact.
 *
 * Equities (cash, or stock F&O on NFO) use their base symbol: the listed-symbol
 * index tags those. Commodities and indices need an alias above.
 */
export function newsKeyFor(underlying: string, exchange?: string | null): NewsKey {
  const upper = String(underlying ?? '').trim().toUpperCase();
  const base = upper.replace(/^(.+)-[A-Z0-9]{1,3}$/, '$1');
  const key = PARENT[base] ?? base;
  if (UNDERLYING_NEWS_ALIASES[key]) return { key };
  if (String(exchange ?? '').toUpperCase() === 'MCX') {
    return {
      key: null,
      reason:
        `no headline keyword mapping exists for the MCX underlying ${base}, so news is never tagged to it — ` +
        'the news feed cannot see this commodity; this is NOT a finding that nothing was published',
    };
  }
  if (INDEX_UNDERLYINGS.has(key)) {
    return {
      key: null,
      reason:
        `no headline keyword mapping exists for the index ${base}, so news is never tagged to it — ` +
        'the news feed cannot see this index; this is NOT a finding that nothing was published',
    };
  }
  return { key };
}
