/**
 * Present WITH provenance, or absent WITH a reason. There is no third state and
 * no silent zero.
 *
 * Borrowed deliberately from `trade-sentinel/services/context-packet.service.ts`
 * (`Block<T>`), because a health payload fails the same way an LLM packet does:
 * a signal that is quietly OMITTED when its query throws reads, to whoever is
 * staring at the JSON at 03:00, exactly like a platform with nothing to report.
 * `/healthz` said `{"status":"ok","db":"ok"}` straight through an OOM restart
 * loop, a 21-hour-frozen option price, and a trade-sentinel that had never once
 * executed in production — all three were invisible precisely because absence
 * looked like health. An absence has to arrive as an explicit absence.
 */
export type Signal<T> =
  | { available: true; value: T; source: string }
  | { available: false; reason: string };

export function present<T>(value: T, source: string): Signal<T> {
  return { available: true, value, source };
}

export function unavailable(reason: string): Signal<never> {
  return { available: false, reason };
}

/**
 * A "when did this last move" reading.
 *
 * `at`/`ageSec` are BOTH null when the table has no matching row, and that is a
 * successful read — not an error and emphatically not a zero. A never-run
 * trade-sentinel must report `at: null`; reporting `ageSec: 0` would mean "it
 * ran this instant", the exact opposite of the truth, and that lie is what let
 * a sentinel sit un-executed in production for weeks.
 */
export interface Freshness {
  /** ISO-8601 UTC instant of the newest row, or null when there are no rows. */
  at: string | null;
  /** Whole seconds between `at` and the check, or null when there are no rows. */
  ageSec: number | null;
}

/**
 * Market-session context, reported ALONGSIDE every age so the age can be read.
 *
 * A 40 000-second-old candle is perfectly correct at 02:00 IST and means the
 * feed is dead at 11:00 IST. Rather than bake that judgement into a boolean
 * verdict — which would flip to "unhealthy" every single night and make Render's
 * HTTP probe kill a perfectly good container until dawn — we publish the raw
 * numbers plus the context needed to interpret them, and let alerting (which
 * can be silenced overnight) draw the conclusion.
 */
export interface SessionContext {
  /** 'YYYY-MM-DD HH:mm:ss' IST wall clock — the frame the ages must be read in. */
  istTime: string;
  /** True only inside the NSE regular session, 09:15–15:30 IST on a weekday. */
  marketOpen: boolean;
  phase: 'PRE_OPEN' | 'REGULAR' | 'POST_CLOSE' | 'WEEKEND';
}

/** Feed liveness — the subscription slot exhaustion that froze a live price. */
export interface FeedSignal {
  active: boolean;
  mode: string;
  /** Distinct tokens holding a subscription slot right now. */
  subscribedTokens: number;
  primarySubscriptions: number;
  scanSubscriptions: number;
  /** False means no broker session at all — the feed cannot be active. */
  brokerAdapterAvailable: boolean;
  /**
   * The FEED's own opinion of whether the market is open, reported next to
   * `session.marketOpen`, which is computed independently.
   *
   * When those two disagree the feed is not subscribing because it believes the
   * market is shut — a container running on a non-IST clock, or a holiday/DST
   * edge — and every downstream age goes stale for a reason that has nothing to
   * do with the network. Two independent readings make that one glance.
   */
  feedThinksMarketOpen: boolean;
}

/**
 * Injection token for the feed status source.
 *
 * HealthService depends on this NARROW structural shape rather than on
 * `MarketFeedService` itself, for two reasons. First, it pins the health check
 * to the three methods that are ALREADY public — a health check must never be
 * the reason a service grows a getter, or the probe starts dictating the design
 * of the thing it observes. Second, `market-feed.service.ts` drags in ioredis,
 * the WebSocket gateway and the whole broker graph at import time; keeping that
 * out of this file's module graph is what lets the spec run in milliseconds
 * without booting a broker.
 *
 * Bound to the real service in `health.module.ts` via `useExisting`.
 */
export const FEED_STATUS_SOURCE = 'HEALTH_FEED_STATUS_SOURCE';

/** The already-public slice of MarketFeedService that the probe reads. */
export interface FeedStatusSource {
  getStatus(): {
    feedActive: boolean;
    feedMode: string;
    primarySubscriptions: number;
    scanSubscriptions: number;
    brokerAdapterAvailable: boolean;
  };
  getSubscribedTokens(): string[];
  isMarketOpen(): boolean;
}

/**
 * The full `GET /healthz` body.
 *
 * `status` is ALWAYS 'ok' and the endpoint is always HTTP 200 — see
 * {@link HealthController} for why we refuse to give Render a reason to
 * restart the container.
 */
export interface HealthPayload {
  status: 'ok';
  db: 'ok' | 'error';
  uptimeSec: number;
  checkedAt: string;
  session: SessionContext;
  feed: Signal<FeedSignal>;
  lastCandleAt: Signal<Freshness>;
  lastTrackerUpdateAt: Signal<Freshness>;
  lastVerdictAt: Signal<Freshness>;
  openPositions: Signal<number>;
}

/**
 * Re-exported here so the health payload's vocabulary lives in one file; the
 * conversion itself stays in `health.memory.ts` where it can be unit-tested
 * without provoking real memory pressure.
 */
export type { ProcessMemory } from './health.memory';
