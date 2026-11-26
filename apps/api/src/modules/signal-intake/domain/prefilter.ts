import { isNumber, isPriceLike, normalise, type Normalised } from './text';
import { AMBIGUOUS_SYMBOLS, LOOSE_STOPWORDS, SECTOR_INDEX_TOKEN, type Vocabulary } from './vocabulary';

/**
 * Contract §S rule 1 — the FREE deterministic pre-filter. A message can only be a trade signal when it
 * has (a) an instrument token: an index / commodity / listed cash symbol from the vocabulary, or a
 * strike + CE/PE; (b) an action word; (c) at least two numbers that look like prices. Ads and P&L
 * recaps are blocked even when they happen to carry all three. Everything that fails is stored as
 * NOISE and never reaches an LLM.
 */

export const ACTION_WORDS: ReadonlySet<string> = new Set([
  'BUY', 'SELL', 'LONG', 'SHORT', 'ABOVE', 'BELOW', 'ACCUMULATE', 'ADD', 'BTST', 'STBT', 'HEROZERO', 'GO',
]);

/** Promotion / channel-marketing vocabulary (also the INFO classifier's ad gate). */
export const AD_RE = /\b(JOIN|SUBSCRIBE|SUBSCRIPTION|WHATSAPP|WATSAPP|WHAT\s*S\s*APP|CONTACT|DM|INBOX|FEES?|COURSE|WEBINAR|OFFER|DISCOUNT|PAYMENT|PAID|MEMBERSHIP|PREMIUM\s+GROUP|VIP\s+GROUP|PAID\s+GROUP|BATCH|YOUTUBE|LIVE\s+CLASS|MENTORSHIP|LINK|REFER|REFERRAL|OPEN\s+(YOUR\s+)?(DEMAT|ACCOUNT)|ENROLL|ADMISSION|SEATS?|LIMITED\s+SLOTS?)\b/;
/** P&L recaps and accuracy brags — they name instruments and prices but are not calls. */
export const RECAP_RE = /\b(PNL|P&L|P\/L|TOTAL\s+PROFIT|TODAY'?S?\s+PROFIT|NET\s+PROFIT|PROFIT\s+OF|PROFIT\s+\+?\d{3,}|\d{3,}\s*\+?\s*PROFIT|ACCURACY|SCREENSHOT|TESTIMONIAL|MONTHLY\s+REPORT|WEEKLY\s+REPORT|POINTS\s+CAPTURED|PTS\s+CAPTURED)\b/;

const LEVEL_CALL_RE = /\bSUPPORT \d+(\.\d+)? .*\b(VIEW|FOR) \d/;
/** "Bullish View On ALKEM LAB 5300CE CMP 145 Support 50" — an option call with no target (Stock Gainers, 2026-11-12). */
const BULLISH_CMP_CALL_RE = /\bBULLISH\b.*\bCMP \d+(\.\d+)? .*\bSUPPORT \d/;
/** A cash pick laid out "CMP 785 SUPPORT 765 FOR 820" (CMP = current price, support = stop, for = target). */
const CASH_LEVEL_CALL_RE = /\bCMP \d+(\.\d+)? .*\bSUPPORT \d+(\.\d+)? .*\b(VIEW|FOR|TGT) \d/;

export type PrefilterReason = 'ok' | 'empty' | 'sector-index' | 'no-instrument' | 'no-action' | 'too-few-prices' | 'ad' | 'recap';

export interface PrefilterResult {
  pass: boolean;
  reason: PrefilterReason;
  /** Canonical underlyings named (vocabulary order of appearance, unique). */
  underlyings: string[];
  norm: Normalised;
}

/** Index of each token that names an instrument (ambiguous words only beside a strike / CE / PE / FUT). */
export function instrumentHits(tokens: readonly string[], vocab: Vocabulary): Array<{ i: number; name: string }> {
  const out: Array<{ i: number; name: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const name = vocab.names.get(tokens[i]);
    if (!name) continue;
    // SME symbols that are plain words (EXCELLENT, MOMENTUM, CURRENT): a stock only beside a contract.
    if (LOOSE_STOPWORDS.has(tokens[i]) && !contractBeside(tokens, i)) continue;
    if (AMBIGUOUS_SYMBOLS.has(tokens[i]) && !contractBeside(tokens, i) && !levelBeside(tokens, i, vocab)) continue;
    out.push({ i, name });
  }
  return out;
}

/** Words that make an ambiguous symbol a price-level post ("BSE CASH ABOVE 3860", "BSE 3894 modify support 3870"). */
const LEVEL_WORDS: ReadonlySet<string> = new Set(['CASH', 'ABOVE', 'BELOW', 'CMP', 'SUPPORT', 'RESISTANCE', 'TARGET', 'TGT', 'SL', 'BUY', 'SELL']);
const isLevelWord = (t: string): boolean => LEVEL_WORDS.has(t) || /^TGT\d$/.test(t);

/**
 * Real NSE symbols that are also everyday channel words ("NIFTY IT", "global cues", "star pick BUY…"): they keep
 * the strict contract-beside rule only. Checked 2026-11-27 — of AMBIGUOUS_SYMBOLS only ABB, BEL, BSE, GLOBAL,
 * IDEA, IT, MCX, RAIN, STAR are NSE cash symbols; the other words can never resolve, so they carry no risk.
 */
const CONTRACT_ONLY: ReadonlySet<string> = new Set(['IT', 'GLOBAL', 'STAR']);

/** A vocabulary instrument that counts on its own (not an ambiguous / loose word). */
function plainInstrument(token: string, vocab: Vocabulary): boolean {
  return vocab.names.has(token) && !AMBIGUOUS_SYMBOLS.has(token) && !LOOSE_STOPWORDS.has(token);
}

/**
 * An ambiguous symbol also counts when a level word or a number is one of the next 2 tokens (2026-11-26:
 * "BSE CASH ABOVE 3860" was NOISE), unless another instrument follows within those 2 tokens ("MCX GOLD",
 * "IDEA: BUY NIFTY") — there it is the exchange / ordinary word. A level word is never the instrument itself.
 */
function levelBeside(tokens: readonly string[], i: number, vocab: Vocabulary): boolean {
  if (isLevelWord(tokens[i]) || CONTRACT_ONLY.has(tokens[i])) return false;
  const next = tokens.slice(i + 1, i + 3);
  if (next.some((t) => plainInstrument(t, vocab))) return false;
  return next.some((t) => isLevelWord(t) || isNumber(t));
}

function contractBeside(tokens: readonly string[], i: number): boolean {
  const next = tokens.slice(i + 1, i + 4);
  if (next[0] === 'FUT') return true;
  return isNumber(next[0] ?? '') && (next[1] === 'CE' || next[1] === 'PE');
}

/** True when a strike + CE/PE pair appears ("24000 CE"). */
export function hasStrikePair(tokens: readonly string[]): boolean {
  for (let i = 1; i < tokens.length; i++) if ((tokens[i] === 'CE' || tokens[i] === 'PE') && isNumber(tokens[i - 1])) return true;
  return false;
}

export function prefilter(raw: string, vocab: Vocabulary): PrefilterResult {
  const norm = normalise(raw, vocab);
  const t = norm.tokens;
  const fail = (reason: PrefilterReason, underlyings: string[] = []): PrefilterResult => ({ pass: false, reason, underlyings, norm });
  if (t.length === 0) return fail('empty');

  const hits = instrumentHits(t, vocab);
  const underlyings = [...new Set(hits.map((h) => h.name))];
  if (hits.length === 0 && !hasStrikePair(t)) return fail(t.includes(SECTOR_INDEX_TOKEN) ? 'sector-index' : 'no-instrument');
  // An option post laid out as "<strike> CE 15-16 SUPPORT 9 VIEW 21" (Stock Gainers) is a call without an action word.
  const cashCall = hits.some((h) => vocab.classOf.get(h.name) === 'STOCK') && CASH_LEVEL_CALL_RE.test(norm.text);
  const levelCall = (hasStrikePair(t) && (LEVEL_CALL_RE.test(norm.text) || BULLISH_CMP_CALL_RE.test(norm.text))) || cashCall;
  if (!levelCall && !t.some((w) => ACTION_WORDS.has(w))) return fail('no-action', underlyings);
  let prices = 0;
  for (let i = 0; i < t.length; i++) if (isPriceLike(t, i)) prices++;
  if (prices < 2) return fail('too-few-prices', underlyings);
  const hasRiskWords = t.includes('SL') || t.some((w) => /^TGT\d?$/.test(w));
  if (AD_RE.test(norm.text) && !hasRiskWords) return fail('ad', underlyings);
  if (RECAP_RE.test(norm.text)) return fail('recap', underlyings);
  return { pass: true, reason: 'ok', underlyings, norm };
}
