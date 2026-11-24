/**
 * How long without a tick before the feed counts as stalled.
 *
 * Matches the 6s the temporary diagnostic used, which was chosen against real
 * observed tick cadence during a live session.
 */
export const STALE_TICK_THRESHOLD_MS = 6_000;

/**
 * `closed`: the tick socket is up, no tick for 6 s, and the clock says no
 * market is in session — silence is expected, not a stall.
 */
export type FeedHealth = 'live' | 'stale' | 'offline' | 'closed';

const IST_OFFSET_MS = 330 * 60_000;
/** NSE cash/F&O session, IST minutes of day. */
const NSE_OPEN_MIN = 9 * 60 + 15;
const NSE_CLOSE_MIN = 15 * 60 + 30;
/** MCX session, IST minutes of day (the later 23:55 close, so the 23:30 summer close is covered). */
const MCX_OPEN_MIN = 9 * 60;
const MCX_CLOSE_MIN = 23 * 60 + 55;

/**
 * Is NSE (09:15–15:30) or MCX (09:00–23:55) in session at `nowMs`? IST is
 * UTC+5:30, Monday–Friday only; the close minute counts as open through its end.
 *
 * Exchange holidays are NOT known here: on a weekday holiday this says "open",
 * so a socket with no ticks still shows Stale, not Market closed. That errs
 * toward the warning, never toward hiding a real stall.
 */
export function isAnyMarketOpen(nowMs: number): boolean {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const nse = min >= NSE_OPEN_MIN && min <= NSE_CLOSE_MIN;
  const mcx = min >= MCX_OPEN_MIN && min <= MCX_CLOSE_MIN;
  return nse || mcx;
}

export interface FeedClassifierInput {
  /** Is the `/ws` socket — the ONLY namespace carrying ticks — connected? */
  tickSocketUp: boolean;
  /** Milliseconds since the last tick frame, or null if none has ever arrived. */
  msSinceLastTick: number | null;
  /** Count of OTHER namespaces up. Recorded, deliberately not used to decide. */
  otherNamespacesUp: number;
  /** Is any market in session now ({@link isAnyMarketOpen})? Outside it, silence is `closed`. */
  marketOpen: boolean;
}

/**
 * Decided by the tick socket and tick recency, plus the market clock only to
 * tell an expected silence (`closed`, outside session hours) from a stall.
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
  const silent =
    input.msSinceLastTick === null || input.msSinceLastTick > STALE_TICK_THRESHOLD_MS;
  if (!silent) return 'live';
  return input.marketOpen ? 'stale' : 'closed';
}

/** Badge colour role. `neutral` = muted text: Market closed is information, not an alarm. */
export type FeedTone = 'positive' | 'warning' | 'negative' | 'neutral';

/** How the feed's health should be presented. Pure, so it can be asserted on. */
export interface FeedBadge {
  label: 'Live' | 'Stale' | 'Offline' | 'Market closed';
  /**
   * Whether to show a connected wifi glyph. True for `stale` on purpose: the
   * socket IS up, and a struck-through icon would trade one false claim for
   * another.
   */
  wifi: boolean;
  tone: FeedTone;
}

const BADGES: Record<FeedHealth, FeedBadge> = {
  live: { label: 'Live', wifi: true, tone: 'positive' },
  stale: { label: 'Stale', wifi: true, tone: 'warning' },
  offline: { label: 'Offline', wifi: false, tone: 'negative' },
  closed: { label: 'Market closed', wifi: true, tone: 'neutral' },
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
