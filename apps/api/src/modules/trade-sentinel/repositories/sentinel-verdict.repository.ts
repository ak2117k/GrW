import { Injectable } from '@nestjs/common';
import type { SentinelVerdict } from '@prisma/client';
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
  packet: unknown;
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
        evidence: input.evidence as never,
        invalidationPoint: input.invalidationPoint,
        reviewInSec: input.reviewInSec,
        packet: input.packet as never,
        promptVersion: input.promptVersion,
        triggeredBy: input.triggeredBy as never,
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
