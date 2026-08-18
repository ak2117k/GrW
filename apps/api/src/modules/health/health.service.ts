import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FEED_STATUS_SOURCE,
  type FeedSignal,
  type FeedStatusSource,
  type Freshness,
  type HealthPayload,
  type SessionContext,
  type Signal,
  present,
  unavailable,
} from './health.types';

/**
 * Per-signal wall-clock budget.
 *
 * Render's HTTP probe and the keep-warm cron both hit this endpoint on a short
 * period. A Neon compute that is waking (or a lock-blocked query) can hang for
 * tens of seconds; without a bound, concurrent probes would pile up on the
 * event loop and the health check itself would become the outage. A signal that
 * blows the budget is reported as unavailable-with-reason — which is the honest
 * answer, since we genuinely do not know its value.
 */
const SIGNAL_BUDGET_MS = 1_500;

/**
 * How long a collected snapshot is reused.
 *
 * Probes arrive every few seconds from more than one source (Render's probe,
 * the keep-warm workflow, whoever is watching a dashboard). Re-running four
 * aggregates per probe would put a pointless steady load on a free-tier Neon
 * compute. 5s is far shorter than any staleness we care about — the failures
 * this endpoint exists to catch are measured in minutes and hours — so the
 * cache costs no fidelity.
 */
const SNAPSHOT_TTL_MS = 5_000;

/** IST is UTC + 5:30. Same convention as `common/utils/market-hours.ts`. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** NSE regular session, as minutes since IST midnight. */
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** The signals that are worth caching — everything that costs a query or a lock. */
type Snapshot = Pick<
  HealthPayload,
  'db' | 'feed' | 'lastCandleAt' | 'lastTrackerUpdateAt' | 'lastVerdictAt' | 'openPositions'
>;

/**
 * Run `work` under a wall-clock budget, converting BOTH failure modes into a
 * stated reason.
 *
 * `common/utils/withBudget` deliberately collapses timeout and rejection into a
 * single fallback value; here the distinction is the whole point. "DB refused
 * the connection" and "the query is still running after 1.5s" call for
 * completely different responses from whoever reads the payload, and a health
 * check that blurs them is back to hiding information.
 *
 * The underlying promise is not cancelled — it is left to settle and its late
 * result ignored. Its rejection is swallowed explicitly so a slow query that
 * fails after the budget cannot surface as an unhandled rejection and take the
 * process down: this endpoint must never be the thing that kills the container.
 */
async function settle<T>(
  work: () => Promise<T>,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${SIGNAL_BUDGET_MS}ms budget`)),
        SIGNAL_BUDGET_MS,
      );
    });
    const started = work();
    started.catch(() => undefined); // late rejection must not go unhandled
    const value = await Promise.race([started, budget]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: describe(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A short, safe rendering of a failure.
 *
 * Only `err.message` is used, never the stack, the Prisma `meta` blob or the
 * error object itself: Prisma connection errors carry the full DATABASE_URL —
 * user, password and host — in their message-adjacent fields, and `/healthz` is
 * `@Public()`, unauthenticated and scraped by external monitors. Anything the
 * driver might have attached is dropped, and the result is length-capped so a
 * pathological message cannot become a data leak by volume.
 */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Turn a newest-row timestamp into a freshness reading.
 *
 * `null` in means the table had no matching row, and that maps to
 * `{at: null, ageSec: null}` — NOT to an age of zero. The trade-sentinel that
 * had never executed once in production is exactly this case, and `ageSec: 0`
 * would have reported it as "ran just now".
 */
export function toFreshness(at: Date | null | undefined, now: Date): Freshness {
  if (!at) return { at: null, ageSec: null };
  return {
    at: at.toISOString(),
    // Clamped at 0: a row written by a host whose clock runs slightly ahead
    // would otherwise report a negative age, which reads as a bug in the probe
    // rather than as the ~0s freshness it actually is.
    ageSec: Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000)),
  };
}

/**
 * Which market session `now` falls in, in IST.
 *
 * Computed here rather than read off the feed on purpose: the session context
 * is what makes every age in this payload interpretable, so it must still be
 * present on exactly the occasions the feed is the thing that is broken.
 */
export function sessionContext(now: Date): SessionContext {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const istTime = ist.toISOString().replace('T', ' ').slice(0, 19);

  if (day === 0 || day === 6) {
    return { istTime, marketOpen: false, phase: 'WEEKEND' };
  }
  if (minutes < SESSION_OPEN_MIN) return { istTime, marketOpen: false, phase: 'PRE_OPEN' };
  if (minutes > SESSION_CLOSE_MIN) return { istTime, marketOpen: false, phase: 'POST_CLOSE' };
  return { istTime, marketOpen: true, phase: 'REGULAR' };
}

/**
 * Collects the "is this platform actually doing its job" signals behind
 * `GET /healthz`.
 *
 * The old check answered one question — can this process serve an HTTP request
 * right now — and answered `ok` through every real incident of the week: an OOM
 * crash loop restarting the container every ~14 minutes, an open option
 * position whose price sat frozen for 21 hours because its token never got a
 * feed subscription slot, and a trade-sentinel that had never run in
 * production. None of those stop the process from replying to an HTTP GET, so
 * none of them were visible. What they DO stop is things moving, so this
 * service reports the FRESHNESS of the things that must keep moving.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private cached: { at: number; snapshot: Snapshot } | null = null;
  private inFlight: Promise<Snapshot> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Optional so the health check survives a bootstrap where the feed failed
     * to construct — the container being feedless is precisely the condition we
     * need reported, and a probe that cannot answer at all in that state is the
     * worst possible outcome.
     */
    @Optional()
    @Inject(FEED_STATUS_SOURCE)
    private readonly feed: FeedStatusSource | null = null,
  ) {}

  async check(): Promise<HealthPayload> {
    const now = new Date();
    const snapshot = await this.snapshot(now);
    return {
      // Always 'ok'. See HealthController for why a probe must not return a
      // verdict that Render can act on.
      status: 'ok',
      checkedAt: now.toISOString(),
      // Deliberately NOT cached: a container in a restart loop resets uptime to
      // near-zero, and that number was the only clue anyone had during the OOM
      // incident. It must be exact on every single probe.
      uptimeSec: Math.round(process.uptime()),
      session: sessionContext(now),
      ...snapshot,
    };
  }

  private async snapshot(now: Date): Promise<Snapshot> {
    const fresh = this.cached && now.getTime() - this.cached.at < SNAPSHOT_TTL_MS;
    if (fresh && this.cached) return this.cached.snapshot;
    // Single-flight: probes overlap, and without this a slow Neon wake-up would
    // let each queued probe start its own four aggregates against the compute
    // that is already struggling.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.collect(now)
      .then((snapshot) => {
        this.cached = { at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Every signal is collected independently and in parallel, and every one of
   * them degrades on its own.
   *
   * This is the single most important property of this file. Render decides
   * whether to KILL the container from an HTTP probe, so a health check that
   * throws when one query is slow converts a transient DB blip into a restart
   * loop — it manufactures the exact outage it was installed to detect. Nothing
   * below is allowed to reject.
   */
  private async collect(now: Date): Promise<Snapshot> {
    const [db, feed, lastCandleAt, trackers, lastVerdictAt] = await Promise.all([
      this.checkDb(),
      Promise.resolve(this.checkFeed()),
      this.checkLastCandle(now),
      this.checkTrackers(now),
      this.checkLastVerdict(now),
    ]);
    return {
      db,
      feed,
      lastCandleAt,
      lastTrackerUpdateAt: trackers.lastUpdate,
      lastVerdictAt,
      openPositions: trackers.open,
    };
  }

  /**
   * `SELECT 1` — also the deliberate side effect that wakes an autosuspended
   * Neon compute, so a real user's login doesn't pay the wake-up cost.
   */
  private async checkDb(): Promise<'ok' | 'error'> {
    const res = await settle(() => this.prisma.$queryRaw`SELECT 1`, 'db ping');
    if (!res.ok) {
      this.logger.warn(`Health DB ping failed: ${res.reason}`);
      return 'error';
    }
    return 'ok';
  }

  /**
   * Feed liveness: active, mode, and how many tokens actually hold a
   * subscription slot.
   *
   * The 21-hour-frozen option price was a slot problem — Angel One caps the
   * WebSocket at ~50 tokens and that position's token never got one. A raw
   * subscribed-token count next to the session context is what makes "the feed
   * is up but is not watching your position" visible at all.
   */
  private checkFeed(): Signal<FeedSignal> {
    if (!this.feed) {
      return unavailable('market feed service not resolvable from this container');
    }
    try {
      const status = this.feed.getStatus();
      return present(
        {
          active: status.feedActive,
          mode: status.feedMode,
          subscribedTokens: this.feed.getSubscribedTokens().length,
          primarySubscriptions: status.primarySubscriptions,
          scanSubscriptions: status.scanSubscriptions,
          brokerAdapterAvailable: status.brokerAdapterAvailable,
          feedThinksMarketOpen: this.feed.isMarketOpen(),
        },
        'MarketFeedService.getStatus',
      );
    } catch (err) {
      return unavailable(`market feed status threw: ${describe(err)}`);
    }
  }

  /**
   * Newest `candles.timestamp`. Stale DURING the regular session means the feed
   * is not writing — which is the difference between "the process is up" and
   * "the platform can see the market".
   */
  private async checkLastCandle(now: Date): Promise<Signal<Freshness>> {
    const res = await settle(
      () => this.prisma.candle.aggregate({ _max: { timestamp: true } }),
      'candles MAX(timestamp)',
    );
    if (!res.ok) return unavailable(res.reason);
    return present(toFreshness(res.value._max.timestamp, now), 'candles.timestamp');
  }

  /**
   * Newest `updatedAt` across OPEN trackers, plus how many are open.
   *
   * Read in ONE aggregate over the `(userId, status)` index because they are
   * two readings of the same set and must agree: "3 open positions, none
   * touched in 21 hours" is a coherent alarm, whereas a count and an age
   * fetched a second apart can disagree and get argued away.
   *
   * This is the signal that would have caught the frozen option price. No user
   * id, symbol or price is reported — an unauthenticated endpoint gets the
   * count and the clock, nothing about anyone's book.
   */
  private async checkTrackers(
    now: Date,
  ): Promise<{ lastUpdate: Signal<Freshness>; open: Signal<number> }> {
    const res = await settle(
      () =>
        this.prisma.tradeTracker.aggregate({
          where: { status: 'OPEN' },
          _max: { updatedAt: true },
          _count: { _all: true },
        }),
      'trade_trackers OPEN aggregate',
    );
    if (!res.ok) {
      return { lastUpdate: unavailable(res.reason), open: unavailable(res.reason) };
    }
    return {
      lastUpdate: present(toFreshness(res.value._max.updatedAt, now), 'trade_trackers.updatedAt'),
      open: present(res.value._count._all, 'trade_trackers count where status=OPEN'),
    };
  }

  /**
   * Newest `sentinel_verdicts.createdAt`.
   *
   * `at: null` is the loud case: the trade-sentinel has produced NOTHING, ever.
   * It shipped and ran zero times in production and no dashboard said so,
   * because "no verdicts" and "healthy" looked identical from the outside.
   */
  private async checkLastVerdict(now: Date): Promise<Signal<Freshness>> {
    const res = await settle(
      () => this.prisma.sentinelVerdict.aggregate({ _max: { createdAt: true } }),
      'sentinel_verdicts MAX(createdAt)',
    );
    if (!res.ok) return unavailable(res.reason);
    return present(toFreshness(res.value._max.createdAt, now), 'sentinel_verdicts.createdAt');
  }
}
