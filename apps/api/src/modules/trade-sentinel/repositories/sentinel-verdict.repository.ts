import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SentinelVerdict } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** Everything needed to persist one agent decision together with the evidence it saw. */
export interface RecordVerdictInput {
  userId: string;
  trackerId: string;
  symbol: string;
  /**
   * The live set, or the OVERNIGHT set (`HOLD_OVERNIGHT | EXIT_AT_OPEN | TIGHTEN_AT_OPEN`).
   * The column is a plain String with no DB constraint, so the overnight words
   * need no migration; `triggeredBy` says which mode wrote the row.
   */
  verdict:
    | 'HOLD'
    | 'EXIT_ARMED'
    | 'EXIT_NOW'
    | 'ESCALATE'
    | 'HOLD_OVERNIGHT'
    | 'EXIT_AT_OPEN'
    | 'TIGHTEN_AT_OPEN';
  confidence: 'low' | 'medium' | 'high';
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN';
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string | null;
  reviewInSec: number;
  /**
   * The full context packet, stored verbatim. Typed as `Prisma.InputJsonValue`
   * rather than `unknown` so the compiler rejects `undefined`/`null` here — the
   * column is a required Json, and a blanket cast would only surface that as a
   * runtime Prisma error. Build packets as object literals or `type` aliases:
   * a declared `interface` has no implicit index signature and will not assign.
   */
  packet: Prisma.InputJsonValue;
  promptVersion: string;
  triggeredBy: string[];
  netPnl: number;
  greenFloor: number | null;
  /** The persisted exitTrigger proposal (price triggers). Omitted = NULL. */
  exitTrigger?: Prisma.InputJsonValue;
  /**
   * News & events v2 OBSERVE mode: the news/events blocks the packet WOULD have
   * carried with the flag on — stored beside the verdict, never in the packet.
   * Omitted / null = SQL NULL (every other mode; existing callers unchanged).
   */
  newsShadow?: Prisma.InputJsonValue | null;
}

/**
 * Verdicts are stored WITH the packet that produced them. That pairing is what
 * makes the agent replayable: a later prompt change can be re-run against the
 * exact evidence and the verdicts diffed.
 */
@Injectable()
export class SentinelVerdictRepository {
  private readonly logger = new Logger(SentinelVerdictRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordVerdictInput): Promise<SentinelVerdict> {
    const shadow = input.newsShadow !== undefined && input.newsShadow !== null;
    try {
      return await this.create(input, shadow);
    } catch (err) {
      if (!shadow) throw err;
      // News & events v2 OBSERVE: the shadow is diagnostics. A write it broke (bad
      // JSON, a column a half-applied migration lacks) must never cost the verdict —
      // the live exit path reads these rows. Retry once without it.
      this.logger.warn(
        `[news-shadow] verdict write with newsShadow failed for ${input.symbol}, retrying without it: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.create(input, false);
    }
  }

  private create(input: RecordVerdictInput, withShadow: boolean): Promise<SentinelVerdict> {
    return this.prisma.sentinelVerdict.create({
      data: {
        userId: input.userId,
        trackerId: input.trackerId,
        symbol: input.symbol,
        verdict: input.verdict,
        confidence: input.confidence,
        thesisStatus: input.thesisStatus,
        recoveryAvailable: input.recoveryAvailable,
        reason: input.reason,
        evidence: input.evidence satisfies Prisma.InputJsonValue,
        invalidationPoint: input.invalidationPoint,
        reviewInSec: input.reviewInSec,
        // Passed through by reference — never cloned, re-serialised or reordered.
        // The replay harness re-runs these packets and must see what the agent saw.
        packet: input.packet,
        promptVersion: input.promptVersion,
        triggeredBy: input.triggeredBy satisfies Prisma.InputJsonValue,
        netPnl: input.netPnl,
        greenFloor: input.greenFloor,
        ...(input.exitTrigger !== undefined ? { exitTrigger: input.exitTrigger } : {}),
        ...(withShadow && input.newsShadow != null ? { newsShadow: input.newsShadow } : {}),
      },
    });
  }

  async listForUser(userId: string, limit: number): Promise<SentinelVerdict[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * `liveOnly` drops rows written by the overnight review. The live cycle reads
   * its "last look" through it: an 08:30 pre-open verdict counted as the last
   * judgement would push the first live heartbeat of the day 15 minutes past the
   * open, and would hand the material-change gate yesterday's close as the
   * baseline. The packet's `memory` block still sees overnight rows (it calls
   * without the flag) — the live judge should know the open plan.
   */
  async recentForTracker(
    trackerId: string,
    limit: number,
    opts: { liveOnly?: boolean } = {},
  ): Promise<SentinelVerdict[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: opts.liveOnly
        ? {
            trackerId,
            NOT: [
              { triggeredBy: { array_contains: ['OVERNIGHT_REVIEW'] } },
              { triggeredBy: { array_contains: ['PRE_OPEN_REVIEW'] } },
              { triggeredBy: { array_contains: ['PRE_OPEN_CHECK'] } },
            ],
          }
        : { trackerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Whether this position already has a verdict recorded under an overnight
   * window tag (see `windowTag` in overnight-calendar.ts). The DURABLE half of
   * the overnight review's idempotency: a cron that fires twice, or a process
   * that restarts mid-window, finds the row and does not judge again.
   */
  async hasWindowVerdict(trackerId: string, tag: string): Promise<boolean> {
    const row = await this.prisma.sentinelVerdict.findFirst({
      where: { trackerId, triggeredBy: { array_contains: [tag] } },
      select: { id: true },
    });
    return row !== null;
  }
}
