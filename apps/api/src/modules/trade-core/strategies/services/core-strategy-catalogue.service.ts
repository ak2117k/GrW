import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type CoreStrategyVersion } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { formatBlockErrors, validateBlocks } from '../blocks/validate-blocks';
import { checkTransition, isEditable, SELECTABLE_STATUSES, type VersionCreator, type VersionStatus } from '../version-status';
import { CoreStrategyRepository } from '../repositories/core-strategy.repository';
import { toStrategyDto, toVersionDto, type CoreStrategyDto, type CoreStrategyVersionDto } from '../dto/core-strategy.dto';

export interface Actor {
  userId: string;
  role: string;
}

export interface DraftInput {
  blocks: unknown;
  notes: string | null;
}

export interface EditVersionResult {
  version: CoreStrategyVersionDto;
  /** true when the edit had to become version n+1 (the target was not a draft). */
  created: boolean;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

function assertValidBlocks(blocks: unknown, allowedVehicles: readonly string[]): void {
  const errors = validateBlocks(blocks, { allowedVehicles });
  if (errors.length > 0) throw new UnprocessableEntityException(`blocks are invalid: ${formatBlockErrors(errors)}`);
}

/**
 * The strategy catalogue (spec §4.2–4.3). Versions are immutable once they leave
 * DRAFT; only the owner (ADMIN) changes a version's mode; LIVE is refused in SP2.
 */
@Injectable()
export class CoreStrategyCatalogueService {
  constructor(
    private readonly repo: CoreStrategyRepository,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor): Promise<CoreStrategyDto[]> {
    const rows = await this.repo.listWithVersions(actor.role === 'ADMIN' ? undefined : SELECTABLE_STATUSES);
    return rows.map(toStrategyDto);
  }

  /**
   * `actorUserId` is the JWT user behind the request (null for a system/AI
   * caller); it is only recorded in the audit row (ruling P6).
   */
  async createDraft(
    strategyId: string,
    input: DraftInput,
    createdBy: VersionCreator = 'OWNER',
    actorUserId: string | null = null,
  ): Promise<CoreStrategyVersionDto> {
    const strategy = await this.repo.findStrategy(strategyId);
    if (!strategy) throw new NotFoundException(`strategy ${strategyId} not found`);
    assertValidBlocks(input.blocks, strategy.allowedVehicles);
    const version = await this.repo.nextVersionNumber(strategyId);
    let row: CoreStrategyVersion;
    try {
      row = await this.repo.createVersion({
        strategyId,
        version,
        blocks: input.blocks as Prisma.InputJsonValue,
        createdBy,
        notes: input.notes,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`${strategy.key} v${version} was created at the same time; retry`);
      throw err;
    }
    // Audit strictly after the write (plan decision 14): a refused draft appends nothing.
    await this.audit.append({
      action: AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_DRAFTED,
      userId: actorUserId,
      target: `core_strategy_version:${row.id}`,
      meta: { strategyKey: strategy.key, version: row.version, createdBy },
    });
    return toVersionDto(row);
  }

  async editVersion(
    versionId: string,
    patch: { blocks?: unknown; notes?: string | null },
    actorUserId: string | null = null,
  ): Promise<EditVersionResult> {
    const current = await this.repo.findVersion(versionId);
    if (!current) throw new NotFoundException(`strategy version ${versionId} not found`);
    const blocks = patch.blocks !== undefined ? patch.blocks : current.blocks;
    const notes = patch.notes !== undefined ? patch.notes : current.notes;
    assertValidBlocks(blocks, current.strategy.allowedVehicles);

    if (isEditable(current.status)) {
      const updated = await this.repo.updateDraft(versionId, { blocks: blocks as Prisma.InputJsonValue, notes });
      if (updated) {
        await this.audit.append({
          action: AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_EDITED,
          userId: actorUserId,
          target: `core_strategy_version:${versionId}`,
          meta: { strategyKey: current.strategy.key, version: current.version },
        });
        const fresh = await this.repo.findVersion(versionId);
        if (!fresh) throw new NotFoundException(`strategy version ${versionId} not found`);
        return { version: toVersionDto(fresh), created: false };
      }
    }
    // Not a draft (or approved while this edit was in flight): immutable, so the
    // edit becomes the next version, a new DRAFT (plan decision 9). createDraft
    // audits it once, as DRAFTED.
    const created = await this.createDraft(current.strategyId, { blocks, notes }, 'OWNER', actorUserId);
    return { version: created, created: true };
  }

  approve(versionId: string, actor: Actor): Promise<CoreStrategyVersionDto> {
    return this.moveTo(versionId, 'PAPER', actor);
  }

  setStatus(versionId: string, to: VersionStatus, actor: Actor): Promise<CoreStrategyVersionDto> {
    return this.moveTo(versionId, to, actor);
  }

  private async moveTo(versionId: string, to: VersionStatus, actor: Actor): Promise<CoreStrategyVersionDto> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner changes a strategy version mode');
    const current = await this.repo.findVersion(versionId);
    if (!current) throw new NotFoundException(`strategy version ${versionId} not found`);
    const from = current.status as VersionStatus;
    const verdict = checkTransition(from, to);
    if (!verdict.ok) throw new ConflictException(verdict.reason);

    const approving = from === 'DRAFT' && to === 'PAPER';
    if (approving) assertValidBlocks(current.blocks, current.strategy.allowedVehicles);
    const data = approving ? { status: to, approvedBy: actor.userId, approvedAt: new Date() } : { status: to };

    const moved = await this.repo.transition(versionId, from, data);
    if (!moved) throw new ConflictException(`strategy version ${versionId} changed while updating; reload and retry`);

    await this.audit.append({
      action: approving
        ? AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_APPROVED
        : AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_STATUS_CHANGED,
      userId: actor.userId,
      target: `core_strategy_version:${versionId}`,
      meta: { strategyKey: current.strategy.key, version: current.version, from, to },
    });
    return toVersionDto({ ...current, ...data });
  }
}
