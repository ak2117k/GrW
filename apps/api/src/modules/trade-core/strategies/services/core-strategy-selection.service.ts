import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreStrategySelection } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { isSelectable } from '../version-status';
import { CoreStrategyRepository } from '../repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from '../repositories/core-strategy-selection.repository';
import { toCapitalDecimal, toSelectionDto, type CoreSelectionDto } from '../dto/core-strategy.dto';

export interface SelectionInput {
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
}

/** Audit meta keeps capital as its exact 2-dp string ("1234.56"), never a float. */
const snapshot = (s: CoreStrategySelection) => ({
  strategyVersionId: s.strategyVersionId,
  enabled: s.enabled,
  capitalAllocation: s.capitalAllocation.toFixed(2),
});

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * A user's dropdown choice per strategy (spec §4.3). The user is always the
 * caller (from the JWT); nothing in the input can name another user. Rules:
 * plan decision 11.
 */
@Injectable()
export class CoreStrategySelectionService {
  constructor(
    private readonly selections: CoreStrategySelectionRepository,
    private readonly catalogue: CoreStrategyRepository,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<CoreSelectionDto[]> {
    return (await this.selections.listForUser(userId)).map(toSelectionDto);
  }

  async set(userId: string, strategyId: string, input: SelectionInput): Promise<CoreSelectionDto> {
    const version = await this.catalogue.findVersion(input.strategyVersionId);
    if (!version || version.strategyId !== strategyId) {
      throw new NotFoundException(`version ${input.strategyVersionId} is not a version of strategy ${strategyId}`);
    }
    const capital = toCapitalDecimal(input.capitalAllocation);
    if (capital === null) {
      throw new UnprocessableEntityException(
        'capitalAllocation must be a number of rupees, 0 or more, with at most 2 decimal places and below 10^12',
      );
    }

    const before = await this.selections.findForUser(userId, strategyId);
    const switchingOffSameVersion = !input.enabled && before?.strategyVersionId === version.id;
    if (!isSelectable(version.status) && !switchingOffSameVersion) {
      throw new ConflictException(
        `${version.strategy.name} v${version.version} is ${version.status}; only an approved (PAPER) version can be selected`,
      );
    }
    if (input.enabled && !capital.gt(0)) {
      throw new UnprocessableEntityException('an enabled strategy needs a capital allocation above ₹0');
    }

    // Two concurrent first PUTs for one (user, strategy) both try to create the row;
    // the loser hits the unique index. Nothing is audited for it: the caller retries.
    let row: CoreStrategySelection;
    try {
      row = await this.selections.upsert(userId, strategyId, {
        strategyVersionId: version.id,
        enabled: input.enabled,
        capitalAllocation: capital,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('selection changed at the same time; retry');
      throw err;
    }
    await this.audit.append({
      action: AUDIT_ACTIONS.strategy.CORE_STRATEGY_SELECTION_CHANGED,
      userId,
      target: `core_strategy_selection:${row.id}`,
      meta: {
        strategyKey: version.strategy.key,
        version: version.version,
        before: before ? snapshot(before) : null,
        after: snapshot(row),
      },
    });
    return toSelectionDto(row);
  }
}
