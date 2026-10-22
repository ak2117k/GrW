import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ProposalDraft, RunSummary, VerificationDraft } from '../self-review.types';

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
const UPSERT_BATCH = 50;

/** self_review_runs / verification_results / tuning_proposals / tuning_overrides (+ agent_lessons reads). */
@Injectable()
export class SelfReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Runs ──────────────────────────────────────────────────────────────────

  createRun(sessionDate: string) {
    return this.prisma.selfReviewRun.create({ data: { sessionDate, status: 'RUNNING' } });
  }

  finishRun(id: string, data: { status: 'DONE' | 'FAILED'; summary?: RunSummary | null; error?: string | null }) {
    return this.prisma.selfReviewRun.update({
      where: { id },
      data: {
        status: data.status,
        finishedAt: new Date(),
        ...(data.summary !== undefined ? { summary: data.summary === null ? Prisma.DbNull : json(data.summary) } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
      },
    });
  }

  async setDiagnosisIfEmpty(id: string, diagnosis: unknown): Promise<void> {
    await this.prisma.selfReviewRun.updateMany({ where: { id, diagnosis: { equals: Prisma.DbNull } }, data: { diagnosis: json(diagnosis) } });
  }

  latestRun() {
    return this.prisma.selfReviewRun.findFirst({ orderBy: { startedAt: 'desc' } });
  }

  latestDoneRun() {
    return this.prisma.selfReviewRun.findFirst({ where: { status: 'DONE' }, orderBy: { startedAt: 'desc' } });
  }

  runs(limit: number) {
    return this.prisma.selfReviewRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  }

  /** DONE runs of a session, newest first (did one already diagnose it?). */
  doneRunsFor(sessionDate: string) {
    return this.prisma.selfReviewRun.findMany({ where: { sessionDate, status: 'DONE' }, orderBy: { startedAt: 'desc' }, take: 10 });
  }

  /** The newest DONE run of the latest session before `sessionDate` (the previous night's run). */
  previousDoneRun(sessionDate: string) {
    return this.prisma.selfReviewRun.findFirst({
      where: { status: 'DONE', sessionDate: { lt: sessionDate } },
      orderBy: [{ sessionDate: 'desc' }, { startedAt: 'desc' }],
    });
  }

  runById(id: string) {
    return this.prisma.selfReviewRun.findUnique({ where: { id } });
  }

  // ─── Results ───────────────────────────────────────────────────────────────

  /** Idempotent on (kind, refId): a re-run overwrites the verdict with what it sees now. */
  async upsertResults(runId: string, drafts: readonly VerificationDraft[]): Promise<number> {
    for (let i = 0; i < drafts.length; i += UPSERT_BATCH) {
      const batch = drafts.slice(i, i + UPSERT_BATCH);
      await this.prisma.$transaction(
        batch.map((d) => {
          const data = {
            runId,
            sessionDate: d.sessionDate,
            subject: d.subject,
            symbol: d.symbol,
            predicted: d.predicted.slice(0, 500),
            actual: d.actual.slice(0, 500),
            correct: d.correct,
            score: d.score,
            details: d.details === null ? Prisma.DbNull : json(d.details),
          };
          return this.prisma.verificationResult.upsert({
            where: { kind_refId: { kind: d.kind, refId: d.refId } },
            create: { kind: d.kind, refId: d.refId, ...data },
            update: data,
          });
        }),
      );
    }
    return drafts.length;
  }

  results(where: { sessionDate?: string; sessions?: string[]; kind?: string; kinds?: string[] }, take = 5000) {
    return this.prisma.verificationResult.findMany({
      where: {
        ...(where.sessionDate ? { sessionDate: where.sessionDate } : {}),
        ...(where.sessions ? { sessionDate: { in: where.sessions } } : {}),
        ...(where.kind ? { kind: where.kind } : {}),
        ...(where.kinds ? { kind: { in: where.kinds } } : {}),
      },
      orderBy: [{ sessionDate: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
      take,
    });
  }

  // ─── Proposals / overrides ─────────────────────────────────────────────────

  proposals(status: string | undefined, limit = 100) {
    return this.prisma.tuningProposal.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** APPLIED / REJECTED proposals, newest decision first (the proposal engine's evidence cut-offs). */
  decidedProposals(limit = 500) {
    return this.prisma.tuningProposal.findMany({
      where: { status: { in: ['APPLIED', 'REJECTED'] } },
      orderBy: { decidedAt: 'desc' },
      take: limit,
    });
  }

  countPending() {
    return this.prisma.tuningProposal.count({ where: { status: 'PENDING' } });
  }

  proposal(id: string) {
    return this.prisma.tuningProposal.findUnique({ where: { id } });
  }

  createProposal(d: ProposalDraft, sourceRun: string) {
    return this.prisma.tuningProposal.create({
      data: {
        key: d.key,
        target: d.target,
        currentValue: json(d.currentValue),
        proposedValue: json(d.proposedValue),
        rationale: d.rationale.slice(0, 1000),
        evidence: json(d.evidence),
        sourceRun,
      },
    });
  }

  expire(ids: string[]) {
    if (ids.length === 0) return Promise.resolve({ count: 0 });
    return this.prisma.tuningProposal.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
  }

  /** Guarded on status: a concurrent decision on the same proposal loses (count 0). */
  async reject(id: string, by: string | null): Promise<boolean> {
    const r = await this.prisma.tuningProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedBy: by },
    });
    return r.count === 1;
  }

  /** PENDING → APPROVED → override written → APPLIED, in one transaction. False when it was no longer PENDING. */
  async approveAndApply(id: string, target: string, value: number | boolean, by: string | null): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tuningProposal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedBy: by },
      });
      if (claimed.count !== 1) return false;
      await tx.tuningOverride.upsert({
        where: { target },
        create: { target, value: json(value), proposalId: id, appliedBy: by },
        update: { value: json(value), proposalId: id, appliedBy: by, appliedAt: new Date() },
      });
      await tx.tuningProposal.update({ where: { id }, data: { status: 'APPLIED' } });
      return true;
    });
  }

  overrides() {
    return this.prisma.tuningOverride.findMany({ orderBy: { target: 'asc' } });
  }

  // ─── Lessons (read side; stream B writes them) ─────────────────────────────

  lessons(status?: string) {
    return this.prisma.agentLesson.findMany({
      where: status ? { status } : {},
      orderBy: [{ status: 'asc' }, { lastSeen: 'desc' }],
      take: 200,
    });
  }

  lessonsFromRun(runId: string) {
    return this.prisma.agentLesson.findMany({ where: { sourceRun: runId }, orderBy: { firstSeen: 'desc' } });
  }

  async retireLesson(id: string): Promise<boolean> {
    const r = await this.prisma.agentLesson.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'RETIRED' } });
    return r.count === 1;
  }
}
