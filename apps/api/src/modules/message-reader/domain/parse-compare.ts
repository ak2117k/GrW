/** Does the AI reader's call match the rule parser's? Pure. */

import { ReaderCall } from './reading.types';

/** The rule parser's view of the same post (fields loose: the parser emits plain strings). */
export interface RuleParse {
  underlying: string;
  side: string;
  optionType: string | null;
  strike: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  targets: number[];
}

/** Prices within this fraction of each other count as the same. */
const PRICE_TOLERANCE = 0.005;

/** Null vs null agrees; null vs a value differs; two values agree within 0.5% of the larger. */
function pricesAgree(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= PRICE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

export function parseAgrees(ai: ReaderCall, rule: RuleParse): { agrees: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (ai.underlying !== rule.underlying) diffs.push('underlying');
  if (ai.side !== rule.side) diffs.push('side');
  if (ai.optionType !== rule.optionType) diffs.push('optionType');
  if (ai.strike !== rule.strike) diffs.push('strike');
  if (!pricesAgree(ai.entryLow, rule.entryLow)) diffs.push('entryLow');
  if (!pricesAgree(ai.entryHigh, rule.entryHigh)) diffs.push('entryHigh');
  if (!pricesAgree(ai.stopLoss, rule.stopLoss)) diffs.push('stopLoss');
  if (!pricesAgree(ai.targets[0] ?? null, rule.targets[0] ?? null)) diffs.push('target');
  return { agrees: diffs.length === 0, diffs };
}
