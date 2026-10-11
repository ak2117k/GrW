import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimitDefault } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import {
  fromStorage,
  isLimitKey,
  isLimitPair,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  parseLimitValue,
  toStorage,
  wireValue,
  type LimitKey,
  type LimitKind,
  type LimitScope,
  type TighterDirection,
} from '../limits/limit-keys';
import { CoreRiskLimitRepository } from '../repositories/core-risk-limit.repository';

export interface CoreRiskDefaultView {
  key: LimitKey;
  scope: LimitScope;
  kind: LimitKind;
  tighter: TighterDirection;
  value: number | string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DefaultChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

function viewOf(key: LimitKey, scope: LimitScope, row: CoreRiskLimitDefault | undefined): CoreRiskDefaultView {
  const value = row ? fromStorage(key, row.numValue, row.textValue) : null;
  return {
    key,
    scope,
    kind: LIMIT_KEYS[key].kind,
    tighter: LIMIT_KEYS[key].tighter,
    value: value === null ? null : wireValue(key, value),
    note: row?.note ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * The global seed defaults (owner answer 1, decision 20): what a user's limit starts
 * at when no UserSettings equivalent exists. Owner only. A change applies to every
 * seed from now on and never touches any user's core_risk_limits rows; each user
 * changes their own limits on the Risk page under D5.
 */
@Injectable()
export class CoreRiskDefaultsService {
  constructor(
    private readonly repo: CoreRiskLimitRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CoreRiskDefaultView[]> {
    const rows = await this.repo.listDefaults();
    return LIMIT_PAIRS.map((p) => viewOf(p.key, p.scope, rows.find((r) => r.key === p.key && r.scope === p.scope)));
  }

  async change(actor: Actor, input: DefaultChangeInput, now: Date = new Date()): Promise<CoreRiskDefaultView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner edits the seed defaults');
    if (!isLimitKey(input.key)) throw new NotFoundException(`unknown limit ${input.key}`);
    if (!isLimitPair(input.key, input.scope)) throw new NotFoundException(`${input.key} has no ${input.scope} scope`);
    const key = input.key;
    const scope = input.scope as LimitScope;
    const parsed = parseLimitValue(key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${key} ${parsed.error}`);
    const reason = input.reason.trim();

    const before = (await this.repo.listDefaults()).find((d) => d.key === key && d.scope === scope);
    const from = before ? fromStorage(key, before.numValue, before.textValue) : null;
    const row = await this.repo.upsertDefault(key, scope, toStorage(key, parsed.value), reason, actor.userId, now);
    await this.audit.append({
      action: AUDIT_ACTIONS.risk.CORE_RISK_DEFAULT_CHANGED,
      userId: actor.userId,
      target: `core_risk_limit_default:${key}@${scope}`,
      meta: { key, scope, from, to: parsed.value, reason },
    });
    return viewOf(key, scope, row);
  }
}
