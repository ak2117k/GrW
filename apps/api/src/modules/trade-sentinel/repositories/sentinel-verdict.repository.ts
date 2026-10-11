import { Injectable } from '@nestjs/common';
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
}

/**
 * Verdicts are stored WITH the packet that produced them. That pairing is what
 * makes the agent replayable: a later prompt change can be re-run against the
 * exact evidence and the verdicts diffed.
 */
@Injectable()
export class SentinelVerdictRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordVerdictInput): Promise<SentinelVerdict> {
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
