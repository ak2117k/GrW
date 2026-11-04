import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { perDecisionPnlOf, worstPerDecision } from './rollup';
import type { DecisionGradeDraft, DecisionGradeRow, DecisionType, DetectorKind, GradeMode, GradeVerdict, Horizon } from './types';

const UPSERT_BATCH = 50;
const READ_MAX = 5000;
const json = (v: unknown): Prisma.InputJsonValue => (v ?? {}) as Prisma.InputJsonValue;

type DbRow = {
  id: string; sessionDate: string; decisionType: string; detector: string | null; refTable: string; refId: string; userId: string | null;
  symbol: string | null; underlying: string | null; mode: string; decidedAt: Date; chosen: string; alternative: string;
  pnlChosen: number | null; pnlAlternative: number | null; deltaRupees: number | null; horizon: string; verdict: string; reason: string;
  facts: Prisma.JsonValue; createdAt: Date;
};

export function toRow(r: DbRow): DecisionGradeRow {
  return {
    ...r,
    decisionType: r.decisionType as DecisionType,
    detector: r.detector as DetectorKind | null,
    mode: r.mode as GradeMode,
    horizon: r.horizon as Horizon,
    verdict: r.verdict as GradeVerdict,
    facts: r.facts && typeof r.facts === 'object' && !Array.isArray(r.facts) ? (r.facts as Record<string, unknown>) : {},
  };
}

/**
 * `decision_grades` (plan 2026-11-04 stream F). The interface G1 (wrongSince) and G2 (perDecisionPnl)
 * read; writes come only from DecisionGradingService.
 */
@Injectable()
export class DecisionGradeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent on (refTable, refId, decisionType, horizon): a rerun overwrites the grade with what it sees now. */
  async upsertMany(drafts: readonly DecisionGradeDraft[]): Promise<number> {
    for (let i = 0; i < drafts.length; i += UPSERT_BATCH) {
      const batch = drafts.slice(i, i + UPSERT_BATCH);
      await this.prisma.$transaction(
        batch.map((d) => {
          const data = {
            sessionDate: d.sessionDate, detector: d.detector, userId: d.userId, symbol: d.symbol, underlying: d.underlying, mode: d.mode,
            decidedAt: d.decidedAt, chosen: d.chosen.slice(0, 200), alternative: d.alternative.slice(0, 200), pnlChosen: d.pnlChosen,
            pnlAlternative: d.pnlAlternative, deltaRupees: d.deltaRupees, verdict: d.verdict, reason: d.reason.slice(0, 500), facts: json(d.facts),
          };
          return this.prisma.decisionGrade.upsert({
            where: { refTable_refId_decisionType_horizon: { refTable: d.refTable, refId: d.refId, decisionType: d.decisionType, horizon: d.horizon } },
            create: { ...data, refTable: d.refTable, refId: d.refId, decisionType: d.decisionType, horizon: d.horizon },
            update: data,
          });
        }),
      );
    }
    return drafts.length;
  }

  /**
   * WRONG decisions and detector hits from `fromSessionDate` (inclusive) on, ONE row per decision (the
   * horizon where the alternative won by the most), newest session first, biggest ₹ first.
   */
  async wrongSince(fromSessionDate: string): Promise<DecisionGradeRow[]> {
    const rows = await this.prisma.decisionGrade.findMany({ where: { sessionDate: { gte: fromSessionDate }, verdict: 'WRONG' }, orderBy: { sessionDate: 'desc' }, take: READ_MAX });
    return worstPerDecision(rows.map(toRow));
  }

  /**
   * ₹ per decision (chosen over the alternative, net per lot; higher = better) of `types` over
   * `sessionDates`; `sessions` = only the sessions that had ≥ 1 scored decision of these types.
   */
  async perDecisionPnl(types: string[], sessionDates: string[]): Promise<{ sessions: string[]; decisions: number; perDecision: number | null }> {
    if (types.length === 0 || sessionDates.length === 0) return { sessions: [], decisions: 0, perDecision: null };
    const rows = await this.prisma.decisionGrade.findMany({
      where: { decisionType: { in: types }, sessionDate: { in: sessionDates }, verdict: { in: ['RIGHT', 'WRONG'] } },
      take: READ_MAX * 4,
    });
    return perDecisionPnlOf(rows.map(toRow), types, sessionDates);
  }

  /** A session's rows (the self-review page / night report). */
  async forSession(sessionDate: string): Promise<DecisionGradeRow[]> {
    const rows = await this.prisma.decisionGrade.findMany({ where: { sessionDate }, orderBy: { decidedAt: 'asc' }, take: READ_MAX });
    return rows.map(toRow);
  }
}
