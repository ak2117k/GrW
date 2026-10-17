import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';

export const DEFAULT_AI_CALLS_WARN_MB = 1024;
const MB = 1024 * 1024;

/** `AI_CALLS_SIZE_WARN_MB`: a non-negative number, 0 = never warn; garbage ⇒ the default. */
export function warnMbFrom(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AI_CALLS_WARN_MB;
}

/**
 * ai_calls SIZE WATCH — the interim answer to "ai_calls has no retention".
 *
 * Each row stores the full request and reply (the sentinel's system prompt and
 * packet, tens of KB), and nothing prunes it. It cannot simply be pruned: the
 * table is append-only by a DB trigger (spec §4.6, audit), and the corpus
 * importer derives sentinel decision records from its bodies
 * (ai-engine/src/corpus/sentinel_records.py). A real retention policy needs
 * an owner decision and a migration. Until then this makes growth visible:
 * one log line a day with the size, and a warning past the threshold.
 */
@Injectable()
export class AiCallsSizeWatch {
  private readonly logger = new Logger(AiCallsSizeWatch.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Cron('0 50 2 * * *', { name: 'ai-calls-size-watch', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    if (!bootJobsEnabled()) return;
    try {
      await this.check();
    } catch (err) {
      this.logger.error(`ai_calls size check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async check(): Promise<{ mb: number; rows: number; over: boolean }> {
    const result = await this.prisma.$queryRaw<Array<{ bytes: bigint | number; rows: bigint | number }>>`
      SELECT pg_total_relation_size('"ai_calls"') AS bytes,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = 'ai_calls') AS rows`;
    const mb = Math.round(Number(result[0]?.bytes ?? 0) / MB);
    const rows = Math.max(0, Number(result[0]?.rows ?? 0));
    const warnMb = warnMbFrom(this.config?.get<string>('AI_CALLS_SIZE_WARN_MB'));
    const over = warnMb > 0 && mb > warnMb;
    this.logger.log(`ai_calls: ${mb} MB, ${rows} rows (estimate)`);
    if (over) {
      this.logger.warn(
        `ai_calls is ${mb} MB > ${warnMb} MB (AI_CALLS_SIZE_WARN_MB) and has no retention — ` +
          'decide a policy (archive + relax the append-only trigger) before it grows further',
      );
    }
    return { mb, rows, over };
  }
}
