import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import { isPaperKey, isPaperPair, PAPER_KEYS, parsePaperValue, resolvePaperSettings, type PaperKey, type PaperSettingsResult } from '../paper-settings';
import { CorePaperDefaultsRepository, type PaperDefaultRow } from '../repositories/core-paper-defaults.repository';

/** How long resolved settings are reused (a bound on staleness after an edit by another instance). */
export const PAPER_SETTINGS_CACHE_MS = 5_000;

export interface CorePaperDefaultView {
  key: PaperKey;
  scope: string;
  value: number;
  note: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface PaperDefaultChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

const viewOf = (r: PaperDefaultRow): CorePaperDefaultView => ({
  key: r.key as PaperKey,
  scope: r.scope,
  value: r.numValue.toNumber(),
  note: r.note,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

const keyRank = (k: string) => PAPER_KEYS.indexOf(k as PaperKey);

/**
 * The paper settings (spec §4.5): resolved from core_paper_defaults for every order,
 * fill and interest run, and edited by the owner only (mirrors M2's
 * CoreRiskDefaultsService). A read failure throws so every caller fails closed; it is
 * never cached. core_paper_defaults.updated_at has no @updatedAt, so a change passes
 * `now` and the actor to the repository's upsert, which writes both explicitly.
 */
@Injectable()
export class CorePaperDefaultsService {
  private cache: { at: number; result: PaperSettingsResult } | null = null;

  constructor(
    private readonly repo: CorePaperDefaultsRepository,
    private readonly audit: AuditService,
  ) {}

  async settings(now: number = Date.now()): Promise<PaperSettingsResult> {
    if (this.cache && now - this.cache.at < PAPER_SETTINGS_CACHE_MS) return this.cache.result;
    const result = resolvePaperSettings(await this.repo.list());
    this.cache = { at: now, result };
    return result;
  }

  async list(): Promise<CorePaperDefaultView[]> {
    const rows = await this.repo.list();
    return [...rows].sort((a, b) => keyRank(a.key) - keyRank(b.key) || a.scope.localeCompare(b.scope)).map(viewOf);
  }

  async change(actor: Actor, input: PaperDefaultChangeInput, now: Date = new Date()): Promise<CorePaperDefaultView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner edits the paper defaults');
    if (!isPaperKey(input.key)) throw new NotFoundException(`unknown paper setting ${input.key}`);
    if (!isPaperPair(input.key, input.scope)) {
      throw new NotFoundException(
        input.key === 'maxLotsPerOrder' ? 'maxLotsPerOrder is scoped by an upper-case underlying such as NIFTY' : `${input.key} has no ${input.scope} scope`,
      );
    }
    const parsed = parsePaperValue(input.key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${input.key} ${parsed.error}`);
    const reason = input.reason.trim();

    const before = (await this.repo.list()).find((r) => r.key === input.key && r.scope === input.scope);
    const row = await this.repo.upsert(input.key, input.scope, parsed.value, reason, actor.userId, now);
    this.cache = null;
    await this.audit.append({
      action: AUDIT_ACTIONS.paper.CORE_PAPER_DEFAULT_CHANGED,
      userId: actor.userId,
      target: `core_paper_default:${input.key}@${input.scope}`,
      meta: { key: input.key, scope: input.scope, from: before ? before.numValue.toFixed(2) : null, to: parsed.value.toFixed(2), reason },
    });
    return viewOf(row);
  }
}
