import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** One intraday_carry_decisions row (prisma model IntradayCarryDecision). */
export interface CarryDecisionRow {
  id: string;
  userId: string;
  mode: string;
  trackerId: string;
  tradeId: string | null;
  istDay: string;
  symbol: string;
  exchange: string;
  token: string;
  productType: string | null;
  positionSide: string;
  qty: number;
  decision: string;
  reason: string;
  verdictId: string | null;
  facts: unknown;
  decisionPrice: number | null;
  conversionStatus: string | null;
  conversionAttempts: number;
  brokerMessage: string | null;
  exitVerdictId: string | null;
  decidedAt: Date;
  executedAt: Date | null;
  scoreStatus: string;
  gapPct: number | null;
  maxAfter: number | null;
  minAfter: number | null;
  priceAt1015: number | null;
  pnlCarry: number | null;
  pnlExit: number | null;
  scoreVerdict: string | null;
  scoreNote: string | null;
  scoredAt: Date | null;
  updatedAt: Date;
}

export type NewCarryDecision = Pick<
  CarryDecisionRow,
  'userId' | 'mode' | 'trackerId' | 'tradeId' | 'istDay' | 'symbol' | 'exchange' | 'token' | 'productType' | 'positionSide' |
  'qty' | 'decision' | 'reason' | 'verdictId' | 'decisionPrice' | 'conversionStatus' | 'decidedAt'
> & { facts: Prisma.InputJsonValue };

export type CarryDecisionPatch = Partial<
  Pick<
    CarryDecisionRow,
    | 'decision' | 'reason' | 'conversionStatus' | 'conversionAttempts' | 'brokerMessage' | 'exitVerdictId' | 'executedAt'
    | 'scoreStatus' | 'gapPct' | 'maxAfter' | 'minAfter' | 'priceAt1015' | 'pnlCarry' | 'pnlExit' | 'scoreVerdict' | 'scoreNote' | 'scoredAt'
  >
>;

/** The slice of the generated delegate this repository uses (kept structural so it compiles before `prisma generate`). */
interface Delegate {
  create(a: { data: NewCarryDecision }): Promise<CarryDecisionRow>;
  update(a: { where: { id: string }; data: CarryDecisionPatch }): Promise<CarryDecisionRow>;
  findUnique(a: { where: { trackerId_istDay: { trackerId: string; istDay: string } } }): Promise<CarryDecisionRow | null>;
  findMany(a: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }): Promise<CarryDecisionRow[]>;
}

@Injectable()
export class IntradayCarryRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get rows(): Delegate {
    return (this.prisma as unknown as { intradayCarryDecision: Delegate }).intradayCarryDecision;
  }

  /** Insert; null when the (trackerId, istDay) row already exists (another pass or a restart decided it). */
  async create(data: NewCarryDecision): Promise<CarryDecisionRow | null> {
    try {
      return await this.rows.create({ data });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return null;
      throw err;
    }
  }

  update(id: string, data: CarryDecisionPatch): Promise<CarryDecisionRow> {
    return this.rows.update({ where: { id }, data });
  }

  forDay(trackerId: string, istDay: string): Promise<CarryDecisionRow | null> {
    return this.rows.findUnique({ where: { trackerId_istDay: { trackerId, istDay } } });
  }

  /** CARRY / EXIT rows still to score, decided before `before` (an earlier session), oldest first. */
  dueForScoring(before: Date, since: Date, limit = 50): Promise<CarryDecisionRow[]> {
    return this.rows.findMany({
      where: { scoreStatus: 'PENDING', decision: { in: ['CARRY', 'EXIT', 'CAP_BLOCKED_BROKER_SQUARE_OFF'] }, decidedAt: { lt: before, gte: since } },
      orderBy: { decidedAt: 'asc' },
      take: limit,
    });
  }

  scoredSince(since: Date): Promise<CarryDecisionRow[]> {
    return this.rows.findMany({ where: { scoreStatus: 'DONE', scoredAt: { gte: since } }, take: 500 });
  }
}
