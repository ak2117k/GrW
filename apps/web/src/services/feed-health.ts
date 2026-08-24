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

/** How the feed's health should be presented. Pure, so it can be asserted on. */
export interface FeedBadge {
  label: 'Live' | 'Stale' | 'Offline';
  /**
   * Whether to show a connected wifi glyph. True for `stale` on purpose: the
   * socket IS up, and a struck-through icon would trade one false claim for
   * another.
   */
  wifi: boolean;
  tone: 'positive' | 'warning' | 'negative';
}

const BADGES: Record<FeedHealth, FeedBadge> = {
  live: { label: 'Live', wifi: true, tone: 'positive' },
  stale: { label: 'Stale', wifi: true, tone: 'warning' },
  offline: { label: 'Offline', wifi: false, tone: 'negative' },
};

/**
 * Three distinct states, because the middle one is the whole point.
 *
 * The badge this replaces had two: connected or not, decided by
 * `connectedCount > 0` across four namespaces. A stalled tick feed is neither
 * — the socket is up and no prices are arriving — and it was being rendered as
 * "Live". Collapsing `stale` back into either neighbour reintroduces the bug.
 */
export function feedBadge(health: FeedHealth): FeedBadge {
  return BADGES[health];
}
