/**
 * How long without a tick before the feed counts as stalled.
 *
 * Matches the 6s the temporary diagnostic used, which was chosen against real
 * observed tick cadence during a live session.
 */
export const STALE_TICK_THRESHOLD_MS = 6_000;

export type FeedHealth = 'live' | 'stale' | 'offline';

export interface FeedClassifierInput {
  /** Is the `/ws` socket — the ONLY namespace carrying ticks — connected? */
  tickSocketUp: boolean;
  /** Milliseconds since the last tick frame, or null if none has ever arrived. */
  msSinceLastTick: number | null;
  /** Count of OTHER namespaces up. Recorded, deliberately not used to decide. */
  otherNamespacesUp: number;
}

/**
 * Three states, decided ONLY by the tick socket and tick recency.
 *
 * The badge this replaces read `connectedCount > 0` across four namespaces, so
 * `/ws/telegram` being up rendered "Live" over a dead tick feed. Other
 * namespaces are carried in the report for diagnosis and are explicitly not
 * allowed to influence the verdict — that conflation IS the bug.
 *
 * A feed that has never delivered a tick is `stale`, never `live`. "We have not
 * heard anything yet" is not evidence of health.
 */
export function classifyFeed(input: FeedClassifierInput): FeedHealth {
  if (!input.tickSocketUp) return 'offline';
  if (input.msSinceLastTick === null) return 'stale';
  return input.msSinceLastTick > STALE_TICK_THRESHOLD_MS ? 'stale' : 'live';
}
