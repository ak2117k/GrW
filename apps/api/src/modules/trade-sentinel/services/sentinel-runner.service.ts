import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SentinelCycleService, type CycleReport } from './sentinel-cycle.service';
import { isAnyExchangeOpen, isAnyMarketOpen, isExchangeOpen } from '../market-sessions';

/**
 * THE TICK CADENCE. Every-30-seconds, weekdays, 09:15–15:29 IST.
 *
 * It is a deliberate choice and not the smallest number that would work, so
 * here is what it is bounded by on each side.
 *
 * FASTER IS NOT BETTER. The tick rate is NOT the rate the agent is called: the
 * tripwires gate that, and their inputs mostly do not move faster than this
 * anyway. `OI_CAPTURE_INTERVAL_MS` is 60s, so wall readings are reused across
 * two ticks either way. `HEARTBEAT_INTERVAL_MS` is 15 minutes. What a faster
 * poll would actually multiply is the per-tick floor cost — one Prisma read and
 * a level-book lookup per watched position — and, when a sensor is genuinely
 * held down, the number of agent calls before the backoff engages.
 *
 * SLOWER IS NOT SAFER. 30s is the worst-case latency between a support breaking
 * and the sentinel noticing. Stage 0 is measuring judgement quality, and a
 * verdict that is right but arrives two minutes after the level broke is not
 * the same verdict.
 *
 * 30s also lines up with `AGENT_RETRY_BASE_MS`: the first retry after a single
 * bad reply lands on the very next tick rather than idling until the one after.
 *
 * Session-bounded on purpose. Nothing moves out of hours, so an all-day poll
 * would spend the floor cost 24/7 to observe frozen prices. The last tick
 * before 15:30 is the one that matters, and the range ends at 15:29 so it fires.
 */
export const SENTINEL_TICK_CRON = '*/30 * * * * *';

/**
 * How long an `OiWallSnapshot` row is kept.
 *
 * The table had NO retention and NO cleanup anywhere, which for a
 * per-symbol-per-expiry capture running every minute of every session is
 * unbounded growth on a free-tier Postgres. It is kept at all because the shift
 * sensor's `prev` is the last STORED row and because Task 13's replay reads the
 * series — but neither needs history beyond a couple of expiry cycles.
 *
 * 45 days covers two monthly rollovers. `daily-housekeeping` does NOT exist in
 * this repo despite CLAUDE.md §4 listing it, so the cron lives here; when that
 * queue is built, this method is what moves into it.
 */
export const OI_SNAPSHOT_RETENTION_DAYS = 45;

/** Nightly, well after the session and before the pre-market crons. */
export const OI_SNAPSHOT_CLEANUP_CRON = '0 30 2 * * *';

/**
 * Env flag. DEFAULT OFF, deliberately.
 *
 * Every tick of this loop can spend real money — the thesis inference and the
 * verdict both call the Anthropic API — and this code has never run against a
 * live account. A paid polling loop that switches itself on the first time it is
 * deployed is not a safe default, so enabling it is an explicit act. It is
 * config rather than code so turning it on needs no deploy.
 */
export const SENTINEL_ENABLED_KEY = 'SENTINEL_SHADOW_ENABLED';

/**
 * Weekday, and inside the EQUITY session. NSE holidays are NOT modelled.
 *
 * KEPT AND DEPRECATED FOR CALLERS THAT MEAN "is the equity market open" — it is
 * no longer what gates the tick. The runner now asks per user whether any
 * exchange THEY hold is trading, because 15:30 is the NSE close and MCX runs
 * until 23:30: gating everything on the equity window left every commodity
 * position unwatched for eight hours of its own trading day, silently. See
 * `market-sessions.ts`.
 */
export function isWithinSession(now: Date = new Date()): boolean {
  return isExchangeOpen('NSE', now);
}

/**
 * Drives {@link SentinelCycleService} on a clock, and owns the three things a
 * scheduler owns that the cycle deliberately does not.
 */
@Injectable()
export class SentinelRunnerService {
  private readonly logger = new Logger(SentinelRunnerService.name);

  /**
   * Users with a cycle in flight.
   *
   * `SentinelCycleService` keeps its carry-over in a single `this.state` map
   * keyed by trackerId — the green-floor latch, the thesis cooldown, the agent
   * backoff deadline and the OI capture window all live there. Two concurrent
   * runs for one user read and write those entries interleaved: both would pass
   * the same `agentRetryAt` gate, both would call `judge` on the same packet,
   * and both would write a verdict row — doubling the API spend and putting two
   * verdicts at the same instant into the record Task 13 scores. The OI capture
   * is worse: both would miss the same cache window and write two snapshot rows,
   * so the second run's `prev` is the first run's `now` and the shift sensor
   * compares a reading against itself.
   *
   * A slow cycle is the normal cause — an Anthropic call taking longer than the
   * 30s tick is unremarkable — so this is an expected condition, not an error.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly cycle: SentinelCycleService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>(SENTINEL_ENABLED_KEY) === 'true';
  }

  @Cron(SENTINEL_TICK_CRON, { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    // A CHEAP CLOCK-ONLY PRE-GATE, BEFORE ANY QUERY. Gating per user needs to
    // know what each user holds, which needs a database round trip — so a naive
    // per-user gate would put one on every 30-second tick at 03:00, forever.
    // That is exactly the constant background load just removed from the
    // tracker's quote sweep, reintroduced one module over. Outside the widest
    // window any venue keeps, nothing can be open and there is nothing to ask.
    if (!this.enabled || !isAnyMarketOpen()) return;

    let book: Array<{ userId: string; exchange: string }>;
    try {
      book = await this.openTradeVenues();
    } catch (err) {
      this.logger.error(`sentinel tick could not list users: ${describe(err)}`);
      return;
    }

    // THE SESSION GATE IS PER USER, AND IT IS KEYED ON WHAT THEY HOLD.
    //
    // It used to be one global `isWithinSession()` — 09:15 to 15:30 — applied to
    // every position on the platform. Correct for NSE, wrong for MCX, which
    // trades until 23:30, so a commodity position was unwatched for eight hours
    // of its own trading day while the runner returned early on every tick.
    //
    // Per user rather than globally, because the alternative fails the other
    // way: one tenant holding a commodity would keep every other tenant's equity
    // positions being polled all evening, spending real money to re-read prices
    // that stopped moving at 15:30.
    const now = new Date();
    const venuesByUser = new Map<string, string[]>();
    for (const row of book) {
      const list = venuesByUser.get(row.userId);
      if (list) list.push(row.exchange);
      else venuesByUser.set(row.userId, [row.exchange]);
    }

    // Sequential, not `Promise.all`: five positions per user against one
    // Anthropic account, and a fan-out across every user would turn the rate
    // limiter into the thing that decides which positions get watched.
    for (const [userId, exchanges] of venuesByUser) {
      if (!isAnyExchangeOpen(exchanges, now)) continue;
      await this.runForUser(userId);
    }
  }

  /**
   * One user's cycle, guarded and never allowed to throw.
   *
   * `SentinelCycleService.runForUser` REJECTS on a roster failure — it is the
   * one throwing path, and it throws precisely so that a cycle which saw no
   * positions because the query failed is not indistinguishable from a cycle
   * that saw none because there were none. That distinction is worth nothing if
   * the rejection escapes into a bare scheduler tick, where it becomes an
   * unhandled rejection with no symbol, no user and no cause; so it is caught
   * HERE, logged at `error` with the tenant, and explicitly NOT counted as a
   * completed run.
   *
   * Returns the report, or null when the run was skipped or failed — so a
   * caller can tell "did not run" from "ran and found nothing", which is the
   * same distinction one layer up.
   */
  async runForUser(userId: string): Promise<CycleReport | null> {
    if (this.inFlight.has(userId)) {
      this.logger.warn(
        `sentinel cycle for user ${userId} is still running; skipping this tick rather than ` +
          'running two cycles over the same carry-over state',
      );
      return null;
    }

    this.inFlight.add(userId);
    try {
      return await this.cycle.runForUser(userId);
    } catch (err) {
      this.logger.error(`sentinel cycle aborted for user ${userId}: ${describe(err)}`);
      return null;
    } finally {
      // `finally`, so a throw cannot leave the user permanently marked
      // in-flight and silently unwatched for the rest of the process's life.
      this.inFlight.delete(userId);
    }
  }

  /**
   * Tenants with something to watch, AND the exchanges they hold it on. Nobody
   * else costs a roster query.
   *
   * `exchange` is what makes the session gate decidable per user — see `tick`.
   * `distinct` on the PAIR, not on userId alone: a user holding both an NFO
   * option and an MCX future must yield both venues, or the evening half of
   * their book silently stops being watched at 15:30.
   */
  private async openTradeVenues(): Promise<Array<{ userId: string; exchange: string }>> {
    return this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { userId: true, exchange: true },
      distinct: ['userId', 'exchange'],
    });
  }

  /** See {@link OI_SNAPSHOT_RETENTION_DAYS}. Runs regardless of the enable flag. */
  @Cron(OI_SNAPSHOT_CLEANUP_CRON, { timeZone: 'Asia/Kolkata' })
  async pruneOiSnapshots(): Promise<number> {
    const cutoff = new Date(Date.now() - OI_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.oiWallSnapshot.deleteMany({
        where: { capturedAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(
          `pruned ${count} OI wall snapshots older than ${OI_SNAPSHOT_RETENTION_DAYS} days`,
        );
      }
      return count;
    } catch (err) {
      // Never throws out of a scheduled method: a housekeeping failure must not
      // become an unhandled rejection, and the next night retries it anyway.
      this.logger.error(`OI snapshot prune failed: ${describe(err)}`);
      return 0;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}
