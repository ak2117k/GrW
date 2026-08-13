import { Injectable } from '@nestjs/common';
import { Prisma, type SentinelVerdict } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** Everything needed to persist one agent decision together with the evidence it saw. */
export interface RecordVerdictInput {
  userId: string;
  trackerId: string;
  symbol: string;
  verdict: 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE';
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

  async recentForTracker(trackerId: string, limit: number): Promise<SentinelVerdict[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: { trackerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
