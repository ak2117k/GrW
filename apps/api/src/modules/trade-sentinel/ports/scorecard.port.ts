import type { Scorecard } from '../../overnight-scorecard/scorecard.types';

/**
 * Where the overnight review reads a position's latest scorecard from. The
 * scorecard engine (overnight-scorecard module) implements it; until it is
 * wired, the default below answers "no scorecard", and the overnight packet and
 * prompt stay exactly as they were.
 */
export interface ScorecardProvider {
  latest(userId: string, trackerId: string): Promise<Scorecard | null>;
}

/** DI token — an interface cannot be resolved by type. */
export const SCORECARD_PROVIDER = 'SENTINEL_SCORECARD_PROVIDER';

/** The default: never has a scorecard. */
export const NULL_SCORECARD_PROVIDER: ScorecardProvider = {
  latest: async () => null,
};

/** The flag that lets a scorecard into the overnight packet and prompt. Anything but "on" is off. */
export const SENTINEL_SCORECARD_KEY = 'SENTINEL_SCORECARD';

export function scorecardFlagOn(raw: string | undefined | null): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'on';
}
