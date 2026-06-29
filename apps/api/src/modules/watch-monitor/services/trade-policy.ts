/**
 * Trade-admission and capital policy for watch-monitor auto-trades. Pure
 * module — given a score and a timestamp it decides whether a trade is
 * admitted (R3) and how much capital to deploy (R4). One source of truth.
 */

const MIN_SCORE_NORMAL = 47;
const MIN_SCORE_STRICT = 75;

const CAPITAL_TIER_1 = 100_000; // score [45,65)
const CAPITAL_TIER_2 = 150_000; // score [65,75)
const CAPITAL_TIER_3 = 200_000; // score [75,inf)
const STRICT_WINDOW_CAPITAL = 100_000;

export interface TradePolicyInput {
  score: number;
  at: Date;
}

export interface TradePolicyResult {
  admitted: boolean;
  minScore: number;
  /** Capital (INR) to deploy — always a valid tier value, even when not admitted. */
  capital: number;
  reason?: string;
}

/** True when `at`, in IST, is in the half-open window [11:45, 14:00). */
export function isStrictWindow(at: Date): boolean {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000);
  const minutesOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutesOfDay >= 11 * 60 + 45 && minutesOfDay < 14 * 60;
}

export function evaluateTradePolicy(input: TradePolicyInput): TradePolicyResult {
  const strict = isStrictWindow(input.at);
  const minScore = strict ? MIN_SCORE_STRICT : MIN_SCORE_NORMAL;
  const admitted = input.score >= minScore;

  let capital: number;
  if (strict) {
    capital = STRICT_WINDOW_CAPITAL;
  } else if (input.score < 65) {
    capital = CAPITAL_TIER_1;
  } else if (input.score < 75) {
    capital = CAPITAL_TIER_2;
  } else {
    capital = CAPITAL_TIER_3;
  }

  return {
    admitted,
    minScore,
    capital,
    reason: admitted
      ? undefined
      : strict
        ? `score ${input.score} below ${minScore} (11:45-14:00 IST window)`
        : `score ${input.score} below ${minScore}`,
  };
}
