/**
 * Which listed companies is this article about?
 *
 * WHAT THIS REPLACES. The tagger matched a hardcoded list of 49 large-caps, so
 * every other listed company was invisible: 82% of stored articles carried no
 * symbol at all and the sentinel's `newsHit` sensor could never fire for a
 * mid-cap. KEI, MOTHERSON, HAL and BDL were all absent from the list and all
 * present in the instrument table.
 *
 * CASE IS THE PRIMARY FILTER, and getting this wrong is what makes a naive fix
 * worse than the bug. There are 18,949 listed base symbols, and a great many of
 * them are ordinary words — FOCUS, PREMIUM, VALUE, MOMENTUM, TECH are all real
 * tickers. Matching case-insensitively against that set tagged
 * "shares debut at a 21% premium" with PREMIUM and "in focus after Q1" with
 * FOCUS. A sensor that fires on those is one the agent learns to discount,
 * which is worse than one that never fires at all.
 *
 * Financial copy already carries the distinction: a ticker appears as `NMDC` or
 * as a capitalised name like `Voltas`, while the ordinary word appears in lower
 * case. So a token qualifies only if it is ALL-CAPS or Capitalised in the
 * ORIGINAL text. That single rule removes almost every false positive a
 * stoplist would otherwise have to chase one at a time.
 *
 * WHY A SET AND NOT REGEXES. One regex per symbol is 18,949 passes over every
 * article. Tokenising once and intersecting against a Set costs a single pass
 * over the WORDS, so it scales with article length rather than with how many
 * companies are listed in India.
 */

/**
 * Capitalised words that are listed tickers but almost never mean the company
 * in a headline.
 *
 * The case rule above does the heavy lifting; this is only for words that
 * routinely appear capitalised anyway — sentence starts, title-case headlines
 * and proper nouns like "Jackson Hole". Deliberately short: a list that has to
 * grow with every false positive is the recurring bug, not the fix.
 */
export const AMBIGUOUS_SYMBOLS = new Set([
  // Observed against real stored articles, not guessed: these survived the
  // case rule because they appear Capitalised in ordinary prose —
  // "Max Healthcare", "LTIMindtree's Current…".
  'HEALTHCARE',
  'CURRENT',
  'FOCUS',
  'PREMIUM',
  'VALUE',
  'MOMENTUM',
  'TECH',
  'JACKSON',
  'IDEA',
  'TOTAL',
  'GLOBAL',
  'ROYAL',
  'STAR',
  'PRIME',
  'SMART',
  'GRAND',
  'FIRST',
  'BEST',
  'TIME',
  'RISE',
  'INDIA',
  'BANK',
  'POWER',
  'FORCE',
  'ORIENT',
  'UNION',
  'GOLD',
  'OIL',
  'TRENT',
]);

/**
 * Below this length a ticker collides with initialisms constantly — IT, ON, US
 * and AI all appear in financial copy and none of them mean the company. Only
 * 7 of 18,949 symbols are two characters, so the coverage lost is negligible.
 */
export const MIN_SYMBOL_LENGTH = 3;

/** A token is ticker-shaped if it is ALL-CAPS or Capitalised. */
export function isTickerShaped(token: string): boolean {
  if (token.length < MIN_SYMBOL_LENGTH) return false;
  const first = token[0];
  if (first < 'A' || first > 'Z') return false;
  const rest = token.slice(1);
  // ALL-CAPS (NMDC, HAL, BDL) or Capitalised (Voltas, Motherson).
  return rest === rest.toUpperCase() || rest === rest.toLowerCase();
}

/**
 * Split into tokens, PRESERVING CASE — the case is the signal, so upper-casing
 * before the shape test would throw away the only thing separating a ticker
 * from an ordinary word.
 */
export function tokenise(text: string): string[] {
  return String(text ?? '')
    .split(/[^A-Za-z0-9&]+/)
    .filter(Boolean);
}

/**
 * A headline written entirely in capitals carries no case signal, so the shape
 * test would admit every ordinary word in it. Detected so those fall back to
 * matching nothing rather than everything.
 */
export function hasNoCaseSignal(text: string): boolean {
  const letters = String(text ?? '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;
  return letters === letters.toUpperCase();
}

/**
 * The listed symbols mentioned in this text, de-duplicated, first-seen order.
 *
 * `known` is the base-symbol set (series suffix stripped, upper-cased). Pure,
 * so the whole rule is testable without a database.
 */
export function extractSymbols(
  title: string,
  summary: string,
  known: ReadonlySet<string>,
  ambiguous: ReadonlySet<string> = AMBIGUOUS_SYMBOLS,
): string[] {
  const text = `${title ?? ''} ${summary ?? ''}`;
  // No case signal means no way to tell a ticker from a word. Return nothing
  // rather than tagging every common noun in an all-caps headline.
  if (hasNoCaseSignal(text)) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenise(text)) {
    if (!isTickerShaped(token)) continue;
    const upper = token.toUpperCase();
    if (seen.has(upper)) continue;
    if (ambiguous.has(upper)) continue;
    if (!known.has(upper)) continue;
    seen.add(upper);
    found.push(upper);
  }
  return found;
}
