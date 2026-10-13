import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { JobRunnerService } from '../../../common/job-registry';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BROKER_CORPUS_SOURCE, brokerTradeRecord, type BrokerSkip, type VerdictRow } from './broker-corpus';

export const CORE_BROKER_CORPUS_JOB = 'core-broker-corpus';
/** A missed night is caught up; older trackers are a one-off backfill (sync with lookbackDays). */
export const BROKER_CORPUS_LOOKBACK_DAYS = 7;
/** Load bound per run. */
export const BROKER_CORPUS_MAX_TRACKERS = 2_000;
const LEASE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Task 13b: closed broker F&O positions (trade_trackers, kind POSITION) with their outcome and the sentinel's
 * verdicts while they were open, as ai_decision_records (source 'broker:tracker', sourceId = tracker id).
 * Reads only; writes only ai_decision_records, idempotently (createMany skipDuplicates on (source, sourceId)).
 */
@Injectable()
export class BrokerCorpusCron {
  private readonly logger = new Logger(BrokerCorpusCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunnerService,
  ) {}

  @Cron('0 20 16 * * 1-5', { name: CORE_BROKER_CORPUS_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    try {
      await this.jobs.run(CORE_BROKER_CORPUS_JOB, { ttlMs: LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const r = await this.sync(now);
        this.logger.log(`broker corpus: ${r.scanned} scanned, ${r.written} written, ${r.already} already, skipped ${JSON.stringify(r.skipped)}`);
        return r;
      });
    } catch (err) {
      this.logger.error(`broker corpus failed: ${errorText(err)}`);
    }
  }

  async sync(now: Date, opts: { lookbackDays?: number } = {}): Promise<{ scanned: number; written: number; already: number; skipped: Partial<Record<BrokerSkip, number>> }> {
    const since = new Date(now.getTime() - (opts.lookbackDays ?? BROKER_CORPUS_LOOKBACK_DAYS) * DAY_MS);
    const trackers = await this.prisma.tradeTracker.findMany({
      where: { status: 'CLOSED', kind: 'POSITION', exitTime: { gte: since } },
      orderBy: [{ exitTime: 'asc' }, { id: 'asc' }],
      take: BROKER_CORPUS_MAX_TRACKERS,
    });
    const skipped: Partial<Record<BrokerSkip, number>> = {};
    if (trackers.length === 0) return { scanned: 0, written: 0, already: 0, skipped };
    const ids = trackers.map((t) => t.id);
    const [existing, verdicts] = await Promise.all([
      this.prisma.aiDecisionRecord.findMany({ where: { source: BROKER_CORPUS_SOURCE, sourceId: { in: ids } }, select: { sourceId: true } }),
      this.prisma.sentinelVerdict.findMany({ where: { trackerId: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    const done = new Set(existing.map((e) => e.sourceId));
    const byTracker = new Map<string, VerdictRow[]>();
    for (const v of verdicts) byTracker.set(v.trackerId, [...(byTracker.get(v.trackerId) ?? []), v as unknown as VerdictRow]);
    const data: Prisma.AiDecisionRecordCreateManyInput[] = [];
    let already = 0;
    for (const t of trackers) {
      if (done.has(t.id)) {
        already += 1;
        continue;
      }
      const r = brokerTradeRecord(t, byTracker.get(t.id) ?? []);
      if (!r.ok) {
        skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
        continue;
      }
      const { evidence, decision, outcome, ...rest } = r.record;
      data.push({
        ...rest,
        evidence: evidence as Prisma.InputJsonValue,
        decision: decision as Prisma.InputJsonValue,
        outcome: outcome as Prisma.InputJsonValue,
      });
    }
    const written = data.length ? (await this.prisma.aiDecisionRecord.createMany({ data, skipDuplicates: true })).count : 0;
    return { scanned: trackers.length, written, already, skipped };
  }
}
