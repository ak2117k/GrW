import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SelfReviewRepository } from '../repositories/self-review.repository';

/** Who an automatic decision is recorded as (tuning_proposals.decided_by / tuning_overrides.applied_by). */
export const AUTO_BY = 'auto';
export const AUTO_ROLLBACK_BY = 'auto-rollback';

export interface ProposalRow {
  id: string;
  key: string;
  target: string;
  currentValue: unknown;
  proposedValue: unknown;
  rationale: string;
  evidence: unknown;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

/** The store auto-apply runs on (the Prisma one below; a fake in tests). */
export interface AutoApplyStore {
  pending(): Promise<ProposalRow[]>;
  /** APPLIED proposals decided by {@link AUTO_BY} / {@link AUTO_ROLLBACK_BY}, oldest first. */
  autoProposals(): Promise<ProposalRow[]>;
  override(target: string): Promise<{ value: unknown; proposalId: string | null } | null>;
  /** PENDING only: record the step-limited value the auto-apply will write. False when no longer PENDING. */
  restep(id: string, value: number | boolean, evidence: unknown, rationale: string): Promise<boolean>;
  createRollback(d: { target: string; currentValue: unknown; proposedValue: unknown; rationale: string; evidence: unknown }): Promise<{ id: string }>;
  /** The existing approve path (SelfReviewRepository.approveAndApply): PENDING → APPROVED → override → APPLIED. */
  approveAndApply(id: string, target: string, value: number | boolean, by: string): Promise<boolean>;
}

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * Reuses tuning_proposals / tuning_overrides (no new table, 2026-11-05): an automatic apply is the PENDING
 * proposal approved by `auto`; a rollback is a new proposal (evidence.rollbackOf) approved by `auto-rollback`.
 */
@Injectable()
export class AutoApplyRepository implements AutoApplyStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SelfReviewRepository,
  ) {}

  pending(): Promise<ProposalRow[]> {
    return this.prisma.tuningProposal.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200 });
  }

  autoProposals(): Promise<ProposalRow[]> {
    return this.prisma.tuningProposal.findMany({
      where: { status: 'APPLIED', decidedBy: { in: [AUTO_BY, AUTO_ROLLBACK_BY] } },
      orderBy: { decidedAt: 'asc' },
      take: 1000,
    });
  }

  override(target: string) {
    return this.prisma.tuningOverride.findUnique({ where: { target }, select: { value: true, proposalId: true } });
  }

  async restep(id: string, value: number | boolean, evidence: unknown, rationale: string): Promise<boolean> {
    const r = await this.prisma.tuningProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: { proposedValue: json(value), evidence: json(evidence), rationale: rationale.slice(0, 1000) },
    });
    return r.count === 1;
  }

  createRollback(d: { target: string; currentValue: unknown; proposedValue: unknown; rationale: string; evidence: unknown }) {
    return this.prisma.tuningProposal.create({
      data: {
        key: d.target,
        target: d.target,
        currentValue: json(d.currentValue),
        proposedValue: json(d.proposedValue),
        rationale: d.rationale.slice(0, 1000),
        evidence: json(d.evidence),
      },
      select: { id: true },
    });
  }

  approveAndApply(id: string, target: string, value: number | boolean, by: string): Promise<boolean> {
    return this.repo.approveAndApply(id, target, value, by);
  }
}
