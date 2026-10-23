import type { PrefilterResult } from './prefilter';
import { SECTOR_INDEX_TOKEN } from './vocabulary';

/**
 * VIEW = market commentary, not a trade call (prod 2026-10-23: "Nifty IT near resistance area. A
 * monthly close above 33000- 33400 levels needed! Volatile time ahead!" was parsed as a NIFTY FUT BUY).
 * A VIEW is stored (keep-all-data), never emitted as `signal.ready` and never sent to the LLM.
 *
 * A post is a VIEW when it names a non-tradeable sector index (and no tradeable instrument), or when it
 * carries analysis vocabulary and NO explicit trade instruction (an action verb together with an SL or
 * a target). Deterministic and free.
 */

/** Analysis / outlook vocabulary, matched on the normalised (upper-case) text. */
export const ANALYSIS_RE =
  /\b(RESISTANCES?|SUPPORTS?|LEVELS|KEY\s+LEVEL|(MONTHLY|WEEKLY|DAILY|HOURLY|QUARTERLY)\s+(CLOSE|CLOSING|CANDLE|CHART|BASIS)|CLOSE\s+(ABOVE|BELOW)|CLOSING\s+(ABOVE|BELOW|BASIS)|ANALYSIS|OUTLOOK|VIEWS?|MARK\s+THIS|VOLATILE|VOLATILITY|EXPECTED|EXPECTING|EXPECT|NEEDED|NEEDS|REQUIRED|HURDLE|PIVOT|TREND\s*LINE|PATTERN|BULLISH|BEARISH|SENTIMENT|WATCH\s*LIST|ON\s+(MY\s+)?RADAR|KEEP\s+(AN\s+)?EYE|WATCH\s+OUT|LIKELY|POSSIBLE|IF|AGAR|OTHERWISE|SUSTAINS?|SUSTAINED|SUSTAINING|BREAKDOWN|CONSOLIDATION|CONSOLIDATING|RANGE\s+BOUND|SIDEWAYS|STUDY|EDUCATIONAL)\b/g;

const VERBS: ReadonlySet<string> = new Set(['BUY', 'SELL', 'LONG', 'SHORT', 'BTST', 'STBT', 'ACCUMULATE']);

/** An explicit trade instruction: an action verb AND an SL or a target. */
export function hasTradeInstruction(tokens: readonly string[]): boolean {
  const verb = tokens.some((w) => VERBS.has(w));
  const risk = tokens.includes('SL') || tokens.some((w) => /^TGT\d?$/.test(w));
  return verb && risk;
}

/** The VIEW reason for a post the rule parser and the update detector did not take, or null. */
export function viewReason(pf: PrefilterResult): string | null {
  if (pf.reason === 'empty' || pf.reason === 'ad' || pf.reason === 'recap') return null;
  const t = pf.norm.tokens;
  if (pf.underlyings.length === 0 && t.includes(SECTOR_INDEX_TOKEN)) return 'sector index (no derivatives)';
  if (pf.reason === 'no-instrument') return null;
  if (hasTradeInstruction(t)) return null;
  const words = [...new Set((pf.norm.text.match(ANALYSIS_RE) ?? []).map((w) => w.replace(/\s+/g, ' ')))];
  return words.length ? `analysis: ${words.slice(0, 5).join(', ')}` : null;
}
