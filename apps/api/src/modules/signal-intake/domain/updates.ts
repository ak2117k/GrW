import { instrumentHits, RECAP_RE } from './prefilter';
import { isNumber, normalise, type Normalised } from './text';
import type { ParsedUpdate, UpdateKind } from './types';
import type { Vocabulary } from './vocabulary';

/**
 * Follow-up posts about an earlier call ("SL hit", "Target 1 done", "Exit now", "trail SL to cost").
 * They are UPDATE events linked to the channel's earlier signal, never new signals. Deterministic:
 * no LLM is ever spent on an update.
 */

const PATTERNS: Array<[UpdateKind, RegExp]> = [
  ['SL_HIT', /\bSL\s+(HIT|HITTED|TRIGGERED|TRIGGER|GONE|DONE|HUA|HO\s+GAYA)\b|\bSTOPPED\s+OUT\b|\bSTOP\s*LOSS\s+HIT\b/],
  ['EXIT', /\bEXIT\b|\bBOOK\s+(PROFIT|PROFITS|ALL|FULL|NOW|IT)\b|\bCLOSE\s+(ALL|POSITION|IT|TRADE|NOW)\b|\bSQUARE\s*OFF\b|\bSQ\s*OFF\b|\bNIKAL\s+(JAO|LO)\b/],
  ['TARGET_HIT', /\bTGT\s*\d?\s*(\d+(\.\d+)?\s+)?(DONE|HIT|ACHIEVED|ACHIVED|REACHED|COMPLETED?|SMASHED|BOOM)\b|\b(1ST|2ND|3RD|FIRST|SECOND|THIRD|ALL|BOTH)\s+TGTS?\s*(DONE|HIT|ACHIEVED|REACHED|COMPLETED?)?\b|\bTGT\d\s+(DONE|HIT)\b/],
  ['PARTIAL_EXIT', /\bBOOK\s+(PARTIAL|HALF|50\s*%?|SOME)\b|\bPARTIAL\s+(PROFIT|BOOK|BOOKING|EXIT)\b/],
  ['TRAIL_SL', /\bTRAIL(ING|ED)?\s+(SL|STOP)\b|\bSL\s+(TO|AT)\s+(COST|CTC|ENTRY|\d)|\b(MOVE|SHIFT|REVISE|MODIFY|CHANGE)\s+(SL|YOUR\s+SL)\b|\bSL\s+(COST|CTC)\b|\bCTC\b/],
  ['CANCEL', /\b(AVOID|CANCEL|CANCELLED|IGNORE|NOT\s+ACTIVATED|DON'?T\s+TAKE)\b/],
];

const ORDINAL: Record<string, number> = { '1ST': 1, FIRST: 1, '2ND': 2, SECOND: 2, '3RD': 3, THIRD: 3 };

/** Updates are short. A long post with an SL keyword is a new call, not an update. */
const MAX_UPDATE_CHARS = 280;

export function detectUpdate(raw: string, vocab: Vocabulary, pre?: Normalised): ParsedUpdate | null {
  const norm = pre ?? normalise(raw, vocab);
  if (!norm.text || norm.text.length > MAX_UPDATE_CHARS) return null;
  if (RECAP_RE.test(norm.text)) return null;
  const kinds = PATTERNS.filter(([, re]) => re.test(norm.text)).map(([k]) => k);
  if (kinds.length === 0) return null;

  let targetIndex: number | null = null;
  if (kinds.includes('TARGET_HIT')) {
    const m = /\bTGT\s*(\d)\b|\bTGT(\d)\b/.exec(norm.text);
    const o = /\b(1ST|2ND|3RD|FIRST|SECOND|THIRD)\s+TGT/.exec(norm.text);
    targetIndex = m ? Number(m[1] ?? m[2]) : o ? ORDINAL[o[1]] : null;
    if (targetIndex !== null && (targetIndex < 1 || targetIndex > 5)) targetIndex = null;
  }
  const t = norm.tokens;
  const hits = instrumentHits(t, vocab);
  let strike: number | null = null;
  for (let i = 1; i < t.length; i++) if ((t[i] === 'CE' || t[i] === 'PE') && isNumber(t[i - 1])) strike = Number(t[i - 1]);
  return { kind: kinds[0], kinds, targetIndex, underlying: hits[0]?.name ?? null, strike };
}
