import { isNumber, isPriceLike, normalise, type Normalised } from './text';
import { AMBIGUOUS_SYMBOLS, type Vocabulary } from './vocabulary';

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

/** Promotion / channel-marketing vocabulary. */
const AD_RE = /\b(JOIN|SUBSCRIBE|SUBSCRIPTION|WHATSAPP|WATSAPP|CONTACT|DM|INBOX|FEES?|COURSE|WEBINAR|OFFER|DISCOUNT|PAYMENT|PAID|MEMBERSHIP|PREMIUM\s+GROUP|VIP\s+GROUP|LINK|REFER|REFERRAL|OPEN\s+(YOUR\s+)?(DEMAT|ACCOUNT)|ENROLL|ADMISSION|SEATS?|LIMITED\s+SLOTS?)\b/;
/** P&L recaps and accuracy brags — they name instruments and prices but are not calls. */
export const RECAP_RE = /\b(PNL|P&L|P\/L|TOTAL\s+PROFIT|TODAY'?S?\s+PROFIT|NET\s+PROFIT|PROFIT\s+OF|PROFIT\s+\+?\d{3,}|\d{3,}\s*\+?\s*PROFIT|ACCURACY|SCREENSHOT|TESTIMONIAL|MONTHLY\s+REPORT|WEEKLY\s+REPORT|POINTS\s+CAPTURED|PTS\s+CAPTURED)\b/;

export type PrefilterReason = 'ok' | 'empty' | 'no-instrument' | 'no-action' | 'too-few-prices' | 'ad' | 'recap';

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
    if (AMBIGUOUS_SYMBOLS.has(tokens[i]) && !contractBeside(tokens, i)) continue;
    out.push({ i, name });
  }
  return out;
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
  if (hits.length === 0 && !hasStrikePair(t)) return fail('no-instrument');
  if (!t.some((w) => ACTION_WORDS.has(w))) return fail('no-action', underlyings);
  let prices = 0;
  for (let i = 0; i < t.length; i++) if (isPriceLike(t, i)) prices++;
  if (prices < 2) return fail('too-few-prices', underlyings);
  const hasRiskWords = t.includes('SL') || t.some((w) => /^TGT\d?$/.test(w));
  if (AD_RE.test(norm.text) && !hasRiskWords) return fail('ad', underlyings);
  if (RECAP_RE.test(norm.text)) return fail('recap', underlyings);
  return { pass: true, reason: 'ok', underlyings, norm };
}
