import type { Normalised } from './text';

/**
 * A post reporting a completed outcome — "gains done", "target hit", "booked", "x to y++ done", "🎯 done" — is the
 * channel's result of an earlier call: RECAP (or an UPDATE of a call it links to), never a new signal (audit
 * 2026-11-27: Mr. P's "Silver 40 to 44++ … gains done" became a SILVER FUT BUY). Read on the normalised text
 * (🎯 → TGT, ✅ → DONE, "TARGET" → TGT, "40-44" → "40 TO 44", "++" dropped).
 */
const OUTCOME = '(DONE|HIT|ACHIEVED|ACHIVED|REACHED|COMPLETED?|BOOKED|SMASHED)';
const PATTERNS: Array<[string, RegExp]> = [
  ['gains done', new RegExp(`\\b(GAINS?|PROFITS?|POINTS?|PTS)\\s+${OUTCOME}\\b`)],
  ['booked', /\b(PROFIT\s+)?BOOKED\b/],
  ['target hit', new RegExp(`\\bTGT\\s*\\d?\\s*(\\d+(\\.\\d+)?\\s+)?${OUTCOME}\\b|\\b(ALL|BOTH|1ST|2ND|3RD|FIRST|SECOND|THIRD)\\s+TGTS?\\s+${OUTCOME}\\b`)],
  ['move done', new RegExp(`\\b\\d+(\\.\\d+)?\\s+TO\\s+\\d+(\\.\\d+)?\\s+([A-Z]+\\s+)?${OUTCOME}\\b`)],
];

const CALL_VERBS = /\b(BUY|SELL|LONG|SHORT|BTST|STBT|ACCUMULATE)\b/;
/** A stop or a target WITH a price ("SL 100", "TGT 140", "TGT2 180") — "TGT DONE" / "TGT HIT" are not. */
const RISK_LEVEL = /\b(SL|TGT\d?)\s+\d+(\.\d+)?\b/;

/**
 * The post also gives a NEW call: a call verb with a stop or a target price (ruling 2026-11-28: a result + a new
 * call with entry and stop, or entry and target, stays a SIGNAL for the new call; only a pure result is RECAP).
 */
export function hasNewCall(norm: Pick<Normalised, 'text'>): boolean {
  const text = norm.text ?? '';
  return CALL_VERBS.test(text) && RISK_LEVEL.test(text);
}

/** `result: <what>` when the post reports a completed outcome, else null. */
export function resultPostReason(norm: Pick<Normalised, 'text'>): string | null {
  const text = norm.text ?? '';
  if (!text) return null;
  for (const [what, re] of PATTERNS) if (re.test(text)) return `result: ${what} (a completed outcome, never a new signal)`;
  return null;
}
