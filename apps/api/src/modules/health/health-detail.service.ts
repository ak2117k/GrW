import { Inject, Injectable, Optional } from '@nestjs/common';
import { JobRunRepository } from '../../common/job-registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ClientFeedReportDto } from './dto/client-feed-report.dto';
import { toProcessMemory, type ProcessMemory } from './health.memory';
import { toJobFreshness, type JobFreshness } from './health.jobs';
import type { SlotPressure } from '../market-data/services/slot-pressure';
import { FEED_STATUS_SOURCE, present, unavailable, type Signal } from './health.types';

/**
 * Jobs we EXPECT to exist in this environment.
 *
 * Maintained by hand and deliberately so: this list is the assertion that a job
 * OUGHT to run, and it is the only thing that can make a job which has never
 * executed appear in the payload at all. Plan 2 adds each surviving job's name
 * here as it is routed through JobRunnerService.
 */
export const EXPECTED_JOBS: string[] = [];

/** The narrow slice of MarketFeedService this surface reads. */
export interface SlotPressureSource {
  getSlotPressure(): SlotPressure;
}

export interface HealthDetailPayload {
  checkedAt: string;
  memory: Signal<ProcessMemory>;
  jobs: Signal<Record<string, JobFreshness>>;
  slots: Signal<SlotPressure>;
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * The admin-only half of the health surface.
 *
 * Split from HealthService rather than bolted onto it because these signals are
 * NOT safe to publish: job names describe the platform's internals and slot
 * counts describe capacity. `/healthz` stays public and cheap; this pays for a
 * JWT and a role check.
 *
 * Same non-negotiable as its public sibling: every signal degrades on its own
 * and nothing rejects.
 */
@Injectable()
export class HealthDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: JobRunRepository,
    @Optional()
    @Inject(FEED_STATUS_SOURCE)
    private readonly feed: SlotPressureSource | null = null,
  ) {}

  async check(): Promise<HealthDetailPayload> {
    const now = new Date();
    const [memory, jobs, slots] = await Promise.all([
      Promise.resolve(this.checkMemory()),
      this.checkJobs(now),
      Promise.resolve(this.checkSlots()),
    ]);
    return { checkedAt: now.toISOString(), memory, jobs, slots };
  }

  private checkMemory(): Signal<ProcessMemory> {
    try {
      return present(toProcessMemory(process.memoryUsage()), 'process.memoryUsage');
    } catch (err) {
      return unavailable(describe(err));
    }
  }

  private async checkJobs(now: Date): Promise<Signal<Record<string, JobFreshness>>> {
    try {
      const records = await this.runs.lastRunPerJob();
      return present(toJobFreshness(records, EXPECTED_JOBS, now), 'job_runs');
    } catch (err) {
      return unavailable(describe(err));
    }
  }

  private checkSlots(): Signal<SlotPressure> {
    if (!this.feed) return unavailable('market feed service not resolvable from this container');
    try {
      return present(this.feed.getSlotPressure(), 'MarketFeedService.getSlotPressure');
    } catch (err) {
      return unavailable(describe(err));
    }
  }

  /**
   * Store one client stall report.
   *
   * Returns `{ accepted: false }` instead of throwing. The caller is a browser
   * whose feed is ALREADY degraded; answering its diagnostic with a 500 would
   * add a visible error to a session that is merely stale, and could start a
   * retry loop against an endpoint that is failing.
   */
  async recordClientReport(
    userId: string | null,
    dto: ClientFeedReportDto,
  ): Promise<{ accepted: boolean }> {
    try {
      await this.prisma.clientFeedReport.create({
        data: {
          userId,
          health: dto.health,
          tickSocketUp: dto.tickSocketUp,
          secondsSinceLastTick: dto.secondsSinceLastTick ?? null,
          transport: dto.transport ?? null,
          subscribedTokens: dto.subscribedTokens,
          namespaces: dto.namespaces,
          recoveredWithoutReload: dto.recoveredWithoutReload ?? false,
        },
      });
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  }
}
