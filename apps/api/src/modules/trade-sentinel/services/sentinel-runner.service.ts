import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SentinelCycleService, type CycleReport } from './sentinel-cycle.service';

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

/** IST is UTC + 5:30. Same convention as `common/utils/market-hours.ts`. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** Weekday, and inside the regular session. NSE holidays are NOT modelled. */
export function isWithinSession(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= SESSION_OPEN_MIN && minutes < SESSION_CLOSE_MIN;
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
    if (!this.enabled || !isWithinSession()) return;

    let userIds: string[];
    try {
      userIds = await this.usersWithOpenTrades();
    } catch (err) {
      this.logger.error(`sentinel tick could not list users: ${describe(err)}`);
      return;
    }

    // Sequential, not `Promise.all`: five positions per user against one
    // Anthropic account, and a fan-out across every user would turn the rate
    // limiter into the thing that decides which positions get watched.
    for (const userId of userIds) {
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

  /** Tenants with something to watch. Nobody else costs a roster query. */
  private async usersWithOpenTrades(): Promise<string[]> {
    const rows = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
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
