/**
 * Recap / wrap / already-realised-move headlines (2026-11-02). Pure.
 *
 * Prod 26 Oct – 2 Nov: 42 % of the index-tagged impacts were market wraps, live blogs, previews or
 * "stocks to watch" lists, and they read no better than a coin (in-session +60 m hit 47 %, next close
 * 38 %). The self-review lesson `no-direction-from-market-wrap-roundups` (NEWS_IDEAS, 4 right / 0 wrong)
 * and `stale-decline-headlines-not-fresh-catalyst` say the same thing; this makes it a rule for the
 * impact layer too. A recap headline still goes to the model (it can name the symbols / sectors), but
 * its reply is forced NEUTRAL / LOW / priced in (`applyRecapGuard`) so no consumer takes a direction
 * from a story that only describes a move that already happened.
 *
 * Deliberately narrow: a company-specific "X shares drop 4 % on Q2 miss" is NOT a recap (the catalyst
 * is new); "Sensex falls 600 pts as ...", "top gainers and losers", "52-week low", "down 22 % in 2026" are.
 */
import type { ImpactItem } from './impact';

export type RecapKind = 'WRAP' | 'PREVIEW' | 'LIVE_BLOG' | 'LIST' | 'REALISED_MOVE';

const MARKET = String.raw`(?:sensex|nifty(?:\s?50|\s?bank|\s?it|\s?fmcg|\s?auto|\s?pharma|\s?metal)?|bank\s?nifty|markets?(?! regulator)|stock markets?|indian (?:shares|stocks|equities)|d-?street|dalal street|benchmarks?|indices|wall street|us stocks|asian (?:stocks|shares|markets)|european stocks)`;
const MOVE_VERB = String.raw`(?:falls?|fell|rises?|rose|gains?|gained|slips?|slipped|drops?|dropped|jumps?|jumped|surges?|surged|crash(?:es|ed)?|tumbles?|tumbled|ends?|ended|closes?|closed|settles?|settled|extends?|extended|snaps?|snapped|slumps?|slumped|plunges?|plunged|rall(?:y|ies|ied)|soars?|soared|declines?|declined|dives?|dived|sheds?|climbs?|climbed|claws? back|recovers?|recovered|trades? (?:higher|lower|flat)|opens? (?:higher|lower|flat|in (?:red|green))|turns? (?:lower|higher|red|green)|holds? near|hits? record)`;

const RULES: ReadonlyArray<{ kind: RecapKind; re: RegExp }> = [
  { kind: 'LIVE_BLOG', re: /\b(?:live(?:\s+updates?|\s+blog)?\s*[:|-]|live updates\b|share price live|stock market live|market live)/i },
  { kind: 'LIST', re: /\b(?:top (?:gainers|losers)|gainers (?:and|&) losers|stocks to (?:watch|buy|sell)|stocks in (?:news|focus)|buzzing stocks|stocks? that (?:moved|hit)|multibagger|(?:\d+|ten|five) stocks? (?:to|that|knock|deliver|hit|plunge))/i },
  { kind: 'PREVIEW', re: /\b(?:market outlook|stock market (?:outlook|prediction)|ahead of market(?! debut)|trade setup|market setup|pre-?market|what to expect|things (?:that will )?(?:to watch|decide)|factors? (?:to watch|that will|to decide)|week ahead|opening bell|closing bell|market (?:wrap|highlights|update|recap)|markets wrap|(?:sensex|nifty|stock market) (?:today|highlights)|gift nifty (?:signals?|indicates?|points?|up|down|rises?|falls?|trades?)|set for (?:a )?(?:positive|negative|cautious|muted|flat|weak|strong|lower|higher) (?:start|open(?:ing)?)|poised for (?:a )?\w+ (?:start|open(?:ing)?))/i },
  // A % move over a SPAN of time ("19% in 4 days", "30% since April", "65% YTD") — not a data release ("output rises 5.6% in Jan-Sept").
  { kind: 'REALISED_MOVE', re: /\b(?:52-?week (?:high|low)s?|hits? (?:a )?(?:fresh |new )?(?:record|all-?time) (?:high|low)s?|(?:up|down|falls?|fell|rises?|rose|gains?|gained|drops?|dropped|plunges?|plunged|crash(?:es|ed)?|slumps?|tumbles?|surges?|jumps?|rall(?:y|ies|ied)|soars?|zooms?|erodes?)\s+(?:(?:over|nearly|about|up to|more than)\s+)?\d+(?:\.\d+)?\s?%\s+(?:(?:in|over) (?:\d+|a|one|two|three|four|five|six|the (?:past|last)|last) (?:trading )?(?:days?|sessions?|weeks?|months?|years?|quarters?)|in 20\d\d|this (?:week|month|year)|so far|since|year-to-date|ytd|from (?:its |their )?(?:record|52|peak|high|low))|\d+(?:\.\d+)?\s?% ytd\b|(?:\d+|two|three|four|five|six|seven)-(?:day|session|week|month) (?:losing|winning|gaining) (?:streak|run)|worst (?:week|month|year|samvat|quarter)|best (?:week|month|year|samvat|quarter))/i },
  { kind: 'WRAP', re: new RegExp(String.raw`\b${MARKET}\b[^.?!]{0,60}?\b${MOVE_VERB}\b`, 'i') },
  { kind: 'WRAP', re: /\bwhy (?:is )?(?:the )?(?:stock )?market (?:falling|rising|down|up|crashing)\b|\bmarket (?:fall|crash|rally) explained\b/i },
];

/** The recap kind of a headline (first rule that matches), or null for a story that may carry a fresh catalyst. */
export function recapKind(headline: string | null | undefined): RecapKind | null {
  const h = String(headline ?? '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  if (!h) return null;
  for (const r of RULES) if (r.re.test(h)) return r.kind;
  return null;
}

/**
 * A recap's impact carries no direction: NEUTRAL, LOW, priced in, confidence ≤ 0.3. The model's
 * symbols / sectors / index / horizon / one-liner are kept (who the recap was about is still useful).
 */
export function applyRecapGuard(item: ImpactItem, kind: RecapKind | null): ImpactItem {
  if (!kind) return item;
  return {
    ...item,
    direction: 'NEUTRAL',
    magnitude: 'LOW',
    pricedIn: true,
    confidence: Math.min(item.confidence, 0.3),
    oneLine: item.oneLine.startsWith('[recap]') ? item.oneLine : `[recap] ${item.oneLine}`.slice(0, 200),
  };
}
