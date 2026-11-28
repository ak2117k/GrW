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

/** The earliest outcome in the text: which pattern, and where it ends. */
function firstOutcome(text: string): { what: string; end: number } | null {
  let best: { what: string; index: number; end: number } | null = null;
  for (const [what, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { what, index: m.index, end: m.index + m[0].length };
  }
  return best;
}

/**
 * The post also gives a NEW call AFTER its outcome: a call verb and a stop / target price, both after the first
 * outcome match (ruling 2026-11-28; review 2026-11-28: a reposted call with its outcome — "BUY … SL 100 TGT 140 🎯
 * done" — carries the OLD call's own SL / TGT before the outcome, which is not a new call). No outcome → false.
 */
export function hasNewCall(norm: Pick<Normalised, 'text'>): boolean {
  const text = norm.text ?? '';
  const hit = firstOutcome(text);
  if (!hit) return false;
  const after = text.slice(hit.end);
  return CALL_VERBS.test(after) && RISK_LEVEL.test(after);
}

/** `result: <what>` when the post reports a completed outcome, else null. */
export function resultPostReason(norm: Pick<Normalised, 'text'>): string | null {
  const hit = firstOutcome(norm.text ?? '');
  return hit ? `result: ${hit.what} (a completed outcome, never a new signal)` : null;
}
