import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimit } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { SessionClock } from '../../../market-hub/session-clock';
import { CORE_JOURNAL, type CoreJournalPort } from '../../journal/journal-ports';
import { resolveAppendOnly } from '../limits/append-only';
import {
  compareLimit,
  fromStorage,
  isLimitKey,
  isLimitPair,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  pairId,
  parseLimitValue,
  toStorage,
  wireValue,
  type ChangeDirection,
  type LimitKey,
  type LimitKind,
  type LimitScope,
  type TighterDirection,
} from '../limits/limit-keys';
import { seedValueFor, type SeedValue } from '../limits/seed-values';
import { CORE_SESSION_CLOCK } from '../ports';
import { ConcurrentRiskChangeError, CoreRiskLimitRepository } from '../repositories/core-risk-limit.repository';
import type { LimitInForce, LimitSource } from '../risk-wall.types';
import { exchangesForScope, nextSessionOpen } from '../session-open';

export interface PendingLimitView {
  value: number | string;
  effectiveFrom: string;
  setAt: string;
  reason: string;
}

/** One limit as the Risk page shows it (spec §8.4: limits with pending-loosen indicators). */
export interface CoreRiskLimitView {
  key: LimitKey;
  scope: LimitScope;
  kind: LimitKind;
  tighter: TighterDirection;
  /** In force now; null when the pair has no usable row (the wall rejects entries that need it). */
  value: number | string | null;
  source: LimitSource | null;
  /** In force from a seed default: "default — please review". */
  needsReview: boolean;
  effectiveFrom: string | null;
  setAt: string | null;
  setBy: string | null;
  reason: string | null;
  /** The newest change while it is not yet effective (a loosening waiting for the next open). */
  pending: PendingLimitView | null;
}

export interface LimitChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

export interface LimitChangeResult {
  limit: CoreRiskLimitView;
  direction: ChangeDirection;
  effectiveFrom: string;
}

function viewOf(key: LimitKey, scope: LimitScope, rows: readonly CoreRiskLimit[], now: Date): CoreRiskLimitView {
  const { inForce, pending } = resolveAppendOnly(rows, now);
  const value = inForce ? fromStorage(key, inForce.numValue, inForce.textValue) : null;
  const pendingValue = pending ? fromStorage(key, pending.numValue, pending.textValue) : null;
  const usable = inForce !== null && value !== null;
  return {
    key,
    scope,
    kind: LIMIT_KEYS[key].kind,
    tighter: LIMIT_KEYS[key].tighter,
    value: usable ? wireValue(key, value) : null,
    source: usable ? (inForce.source as LimitSource) : null,
    needsReview: usable && inForce.source === 'DEFAULT',
    effectiveFrom: usable ? inForce.effectiveFrom.toISOString() : null,
    setAt: usable ? inForce.createdAt.toISOString() : null,
    setBy: usable ? inForce.setBy : null,
    reason: usable ? inForce.reason : null,
    pending:
      pending && pendingValue !== null
        ? { value: wireValue(key, pendingValue), effectiveFrom: pending.effectiveFrom.toISOString(), setAt: pending.createdAt.toISOString(), reason: pending.reason }
        : null,
  };
}

const rowsFor = (rows: readonly CoreRiskLimit[], key: string, scope: string) => rows.filter((r) => r.key === key && r.scope === scope);

/**
 * A user's own limits (spec §5.2): lazy seed (plan decision 7), the Risk page view,
 * the values in force for the wall, and changes under D5 (tighter or same = now,
 * looser = next session open for the scope's exchanges). Every write is audited.
 */
@Injectable()
export class CoreRiskLimitService {
  constructor(
    private readonly repo: CoreRiskLimitRepository,
    private readonly audit: AuditService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
    @Optional() @Inject(CORE_JOURNAL) private readonly journal?: CoreJournalPort,
  ) {}

  private readonly logger = new Logger(CoreRiskLimitService.name);

  async ensureSeeded(userId: string, now: Date = new Date()): Promise<number> {
    const present = await this.repo.pairsForUser(userId);
    const missing = LIMIT_PAIRS.filter((p) => !present.has(pairId(p)));
    if (missing.length === 0) return 0;
    const [seed, defaults] = await Promise.all([this.repo.settingsForSeed(userId), this.repo.listDefaults()]);
    const values = missing.map((p) => seedValueFor(p, seed, defaults)).filter((s): s is SeedValue => s !== null);
    const inserted = await this.repo.appendIfMissing(
      userId,
      values.map((s) => ({ key: s.key, scope: s.scope, ...toStorage(s.key, s.value), effectiveFrom: now, source: s.source, setBy: 'SEED', reason: s.reason })),
      now,
    );
    if (inserted.length > 0) {
      await this.audit.append({
        action: AUDIT_ACTIONS.risk.CORE_RISK_LIMITS_SEEDED,
        userId,
        target: `core_risk_limits:${userId}`,
        meta: {
          count: inserted.length,
          limits: inserted.map((r) => ({ key: r.key, scope: r.scope, value: isLimitKey(r.key) ? fromStorage(r.key, r.numValue, r.textValue) : null, source: r.source })),
          unseeded: missing.filter((p) => !values.some((s) => s.key === p.key && s.scope === p.scope)).map(pairId),
        },
      });
    }
    return inserted.length;
  }

  async list(userId: string, now: Date = new Date()): Promise<CoreRiskLimitView[]> {
    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForUser(userId);
    return LIMIT_PAIRS.map((p) => viewOf(p.key, p.scope, rowsFor(rows, p.key, p.scope), now));
  }

  async inForce(userId: string, now: Date = new Date()): Promise<LimitInForce[]> {
    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForUser(userId);
    return LIMIT_PAIRS.flatMap((p) => {
      const { inForce } = resolveAppendOnly(rowsFor(rows, p.key, p.scope), now);
      const value = inForce ? fromStorage(p.key, inForce.numValue, inForce.textValue) : null;
      return inForce && value !== null
        ? [{ key: p.key, scope: p.scope, value, rowId: inForce.id, effectiveFrom: inForce.effectiveFrom.toISOString(), source: inForce.source as LimitSource }]
        : [];
    });
  }

  async change(userId: string, input: LimitChangeInput, now: Date = new Date()): Promise<LimitChangeResult> {
    if (!isLimitKey(input.key)) throw new NotFoundException(`unknown limit ${input.key}`);
    if (!isLimitPair(input.key, input.scope)) {
      throw new NotFoundException(`${input.key} has no ${input.scope} scope (it has ${LIMIT_KEYS[input.key].scopes.join(', ')})`);
    }
    const key = input.key;
    const scope = input.scope as LimitScope;
    const parsed = parseLimitValue(key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${key} ${parsed.error}`);
    const reason = input.reason.trim();

    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForPair(userId, key, scope);
    const { inForce, pending, newest } = resolveAppendOnly(rows, now);
    const current = inForce ? fromStorage(key, inForce.numValue, inForce.textValue) : null;
    const direction: ChangeDirection = current === null ? 'LOOSER' : compareLimit(key, current, parsed.value);

    let effectiveFrom = now;
    if (direction === 'LOOSER') {
      const exchanges = exchangesForScope(scope);
      const open = nextSessionOpen(this.clock, exchanges, now);
      if (!open) {
        throw new ConflictException(`no session open is known in the next 14 days for ${exchanges.join('/')}, so a looser ${key} cannot be scheduled`);
      }
      effectiveFrom = open;
    }

    let row: CoreRiskLimit;
    try {
      row = await this.repo.append(
        userId,
        { key, scope, ...toStorage(key, parsed.value), effectiveFrom, source: 'USER', setBy: userId, reason },
        now,
        newest?.id ?? null,
      );
    } catch (err) {
      if (err instanceof ConcurrentRiskChangeError) throw new ConflictException(`${key} (${scope}) changed at the same time; reload and retry`);
      throw err;
    }
    // SP2 M5 (D12): the journal row, best effort — the limit row is already persisted, so a journal
    // failure is logged and never fails the change.
    try {
      this.journal?.record({
        type: 'LIMIT_CHANGED',
        userId,
        at: now,
        payload: { key, scope, from: current, to: parsed.value, direction, effectiveFrom: effectiveFrom.toISOString(), reason, rowId: row.id },
      });
    } catch (err) {
      this.logger.error(`LIMIT_CHANGED journal row for core_risk_limit:${row.id} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.audit.append({
      action: AUDIT_ACTIONS.risk.CORE_RISK_LIMIT_CHANGED,
      userId,
      target: `core_risk_limit:${row.id}`,
      meta: { key, scope, from: current, to: parsed.value, direction, effectiveFrom: effectiveFrom.toISOString(), reason, supersedes: pending?.id ?? null },
    });
    return { limit: viewOf(key, scope, [...rows, row], now), direction, effectiveFrom: effectiveFrom.toISOString() };
  }
}
