/**
 * The four trend/momentum factors (from the 15-factor scorer) that must each
 * individually pass for a loss-recovery re-entry to be considered. Names must
 * match `chartink-scoring.service.ts` exactly.
 */
export const REQUIRED_MOMENTUM_FACTORS = [
  'MACD on 5m',
  'VWAP relationship',
  'RSI on 5m',
  'ADX trend strength',
] as const;

/** Max loss-recovery re-entries per symbol per day. */
export const MAX_RECOVERY_REENTRIES_PER_DAY = 1;

/** Minimum score (exclusive) to admit a loss-recovery re-entry. */
export const MIN_RECOVERY_SCORE = 80;

export interface LossReentryInput {
  /** 15-factor total of the re-firing alert (factors sum to 100). */
  score: number;
  /** The alert's factor breakdown. */
  breakdown: Array<{ name: string; passed: boolean }>;
  /** Current price (live quote, or the alert trigger price as fallback). */
  currentPrice: number;
  /** Entry price of the last closed (losing) trade for this symbol today. */
  priorEntryPrice: number;
  /** How many loss-recovery re-entries already happened for this symbol today. */
  priorRecoveryCount: number;
}

export interface LossReentryVerdict {
  allow: boolean;
  reason: string;
}

/**
 * Decide whether a symbol stopped out for a loss earlier today may be re-entered.
 *
 * This is the quality gate that replaces the blunt green-only block: it re-admits
 * a loss-closed symbol ONLY on overwhelming proof the uptrend genuinely resumed —
 * a bar a dead-cat bounce cannot clear. All conditions must hold; the reason names
 * the first that fails (evaluation order A -> B -> C -> cap).
 */
export function evaluateLossReentry(input: LossReentryInput): LossReentryVerdict {
  // A — strictly stronger fresh signal.
  if (!(input.score > MIN_RECOVERY_SCORE)) {
    return { allow: false, reason: `score ${input.score} not above ${MIN_RECOVERY_SCORE}` };
  }

  // B — each momentum factor must individually pass (absent factor counts as failed).
  for (const name of REQUIRED_MOMENTUM_FACTORS) {
    const factor = input.breakdown.find((c) => c.name === name);
    if (!factor || !factor.passed) {
      return { allow: false, reason: `momentum factor not passing: ${name}` };
    }
  }

  // C — price must have reclaimed the level it broke when it stopped you.
  if (input.currentPrice < input.priorEntryPrice) {
    return {
      allow: false,
      reason: `price ${input.currentPrice} has not reclaimed prior entry ${input.priorEntryPrice}`,
    };
  }

  // Cap — one recovery per symbol per day; no revenge spiral.
  if (input.priorRecoveryCount >= MAX_RECOVERY_REENTRIES_PER_DAY) {
    return { allow: false, reason: `recovery re-entry cap reached (${MAX_RECOVERY_REENTRIES_PER_DAY}/day)` };
  }

  return { allow: true, reason: 'loss-recovery re-entry admitted (score, momentum, reclaim, cap all ok)' };
}
