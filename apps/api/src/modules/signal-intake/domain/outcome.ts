import type { EntryType, Side } from './types';

/**
 * The CHANNEL_SIGNAL outcome (contract §Self-review): replay the signal on its own instrument's bars
 * from the post until the horizon end (session close for intraday, 3 sessions for BTST/positional).
 * The entry must trigger first; then target 1 before the SL → TARGET1 (right), SL first → SL (wrong),
 * neither → NEITHER (null). A bar that touches both is counted as the SL (conservative, as
 * telegram/outcome-eval does).
 */

export type OutcomeStatus = 'TARGET1' | 'SL' | 'NEITHER' | 'NOT_TRIGGERED' | 'NO_DATA' | 'NO_LEVELS' | 'UNRESOLVED';

export interface OutcomeBar {
  ts: number;
  high: number;
  low: number;
  close: number;
}

export interface OutcomeInput {
  side: Side;
  entryType: EntryType;
  entryLow: number;
  entryHigh: number;
  sl: number | null;
  targets: number[];
}

export interface Outcome {
  status: OutcomeStatus;
  entryAt: number | null;
  exitAt: number | null;
  exitPrice: number | null;
}

/** "BUY @ 18": a fill within 1 % of the quoted price counts. */
const AT_TOLERANCE = 0.01;

export function evaluateSignalOutcome(sig: OutcomeInput, bars: readonly OutcomeBar[]): Outcome {
  const none = (status: OutcomeStatus): Outcome => ({ status, entryAt: null, exitAt: null, exitPrice: null });
  const t1 = sig.targets.length ? sig.targets[0] : null;
  if (sig.sl === null && t1 === null) return none('NO_LEVELS');
  const sorted = [...bars].filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low)).sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return none('NO_DATA');

  const buy = sig.side === 'BUY';
  const triggers = (b: OutcomeBar): boolean => {
    switch (sig.entryType) {
      case 'ABOVE':
        return b.high >= sig.entryLow;
      case 'BELOW':
        return b.low <= sig.entryHigh;
      default:
        return b.low <= sig.entryHigh * (1 + AT_TOLERANCE) && b.high >= sig.entryLow * (1 - AT_TOLERANCE);
    }
  };

  let entryAt: number | null = null;
  for (const b of sorted) {
    if (entryAt === null) {
      if (!triggers(b)) continue;
      entryAt = b.ts;
    }
    const slHit = sig.sl !== null && (buy ? b.low <= sig.sl : b.high >= sig.sl);
    if (slHit) return { status: 'SL', entryAt, exitAt: b.ts, exitPrice: sig.sl };
    const tHit = t1 !== null && (buy ? b.high >= t1 : b.low <= t1);
    if (tHit) return { status: 'TARGET1', entryAt, exitAt: b.ts, exitPrice: t1 };
  }
  if (entryAt === null) return none('NOT_TRIGGERED');
  return { status: 'NEITHER', entryAt, exitAt: null, exitPrice: sorted[sorted.length - 1].close };
}

/** right / wrong / null, as the self-review stores it. */
export function outcomeCorrect(status: string | null): boolean | null {
  if (status === 'TARGET1') return true;
  if (status === 'SL') return false;
  return null;
}
