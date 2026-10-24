import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AssistLlmService, type AssistPrincipal } from '../../ai-assist/assist-llm.service';
import { ASSIST_BUSY_MESSAGE, AssistBusyError } from '../../ai-assist/assist-slot';
import { CoreRiskLimitService } from '../../trade-core/risk-wall/services/core-risk-limit.service';
import {
  DEFINITION_MAX_CHARS,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  SUGGEST_SCHEMA,
  SUGGEST_SYSTEM_PROMPT,
  definitionBlock,
  definitionPayload,
  guardStrategyText,
  parseReview,
  parseSuggestions,
  reviewUserTurn,
  sanitiseBacktest,
  suggestUserTurn,
  type StrategyReview,
  type StrategySuggestions,
} from '../domain/ai-contract';
import { runChecks, type CheckReport, type RiskLimitsView } from '../domain/checks';
import { canonicalJson, normaliseBuilderState, type BuilderStateInput, type NormaliseResult } from '../domain/definition';
import { emptyFields } from '../domain/editable-fields';
import { StrategyAiGovernor, type AiJob } from './strategy-ai-governor';

export const STRATEGY_AI_DEFAULT_DAILY_CAP = 30;
export const STRATEGY_AI_DEFAULT_COOLDOWN_MS = 60_000;

export interface AiStatus {
  allowed: boolean;
  remaining: number;
  dailyCap: number;
}

export type AiOutcome<T> =
  | { status: 'ok' | 'cached'; result: T; ai: AiStatus }
  | { status: 'blocked'; reason: string; message: string; retryAfterMs?: number; ai: AiStatus }
  | { status: 'busy' | 'error'; message: string; ai: AiStatus };

export interface CheckResponse {
  checks: CheckReport;
  ai: AiStatus;
}

/**
 * Strategy Builder validation + the owner-only Claude review / suggest.
 *
 * Order of gates for an AI call (cheapest first; nothing below a failed gate runs):
 *   owner → deterministic checks (review: zero errors) → text guard → size cap
 *   → cache → in-flight / repeat / cooldown / daily cap → shared model slot.
 */
@Injectable()
export class StrategyAiService {
  private readonly logger = new Logger(StrategyAiService.name);
  private readonly governor: StrategyAiGovernor<StrategyReview | StrategySuggestions>;

  constructor(
    private readonly config: ConfigService,
    private readonly llm: AssistLlmService,
    @Optional() private readonly riskLimits?: CoreRiskLimitService,
  ) {
    const cap = Number(this.config.get<string>('STRATEGY_AI_DAILY_CAP'));
    const cool = Number(this.config.get<string>('STRATEGY_AI_COOLDOWN_MS'));
    this.governor = new StrategyAiGovernor({
      dailyCap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : STRATEGY_AI_DEFAULT_DAILY_CAP,
      cooldownMs: Number.isFinite(cool) && cool >= 0 ? cool : STRATEGY_AI_DEFAULT_COOLDOWN_MS,
      cacheTtlMs: 24 * 3_600_000,
      cacheMax: 200,
      repeatBlockMs: 10 * 60_000,
    });
  }

  status(user: AssistPrincipal | undefined): AiStatus {
    const allowed = this.llm.allowed(user);
    return {
      allowed,
      remaining: allowed && user ? this.governor.remaining(user.userId) : 0,
      dailyCap: allowed ? this.governor.dailyCap : 0,
    };
  }

  /** Deterministic checklist — every user, no model call. */
  async check(input: BuilderStateInput, user: AssistPrincipal | undefined): Promise<CheckResponse> {
    const n = normaliseBuilderState(input ?? {});
    const limits = await this.limitsFor(user, n);
    return { checks: runChecks(n, limits), ai: this.status(user) };
  }

  async review(input: BuilderStateInput, backtestRaw: unknown, user: AssistPrincipal | undefined): Promise<AiOutcome<StrategyReview>> {
    const owner = this.requireOwner(user);
    const n = normaliseBuilderState(input ?? {});
    const checks = runChecks(n, await this.limitsFor(owner, n));
    if (checks.errors > 0) {
      return this.blocked(owner, 'checks', `Fix the ${checks.errors} failing check${checks.errors > 1 ? 's' : ''} first — Claude reviews only strategies that pass validation.`);
    }
    const pre = this.preflight(owner, n);
    if (pre) return pre;
    const backtest = sanitiseBacktest(backtestRaw);
    const hash = this.hash('strategy.review', { d: definitionPayload(n.definition), b: backtest });
    return this.run<StrategyReview>(owner, n.strategyKey, 'strategy.review', hash, async () =>
      parseReview(await this.llm.completeJson('strategy.review', REVIEW_SYSTEM_PROMPT, reviewUserTurn(n.definition, backtest), REVIEW_SCHEMA, { userId: owner.userId })),
    );
  }

  async suggest(input: BuilderStateInput, user: AssistPrincipal | undefined): Promise<AiOutcome<StrategySuggestions>> {
    const owner = this.requireOwner(user);
    const n = normaliseBuilderState(input ?? {});
    const d = n.definition;
    if (d.entry.long.length + d.entry.short.length === 0 && d.indicators.length === 0) {
      return this.blocked(owner, 'too-empty', 'Add at least an indicator or an entry rule first — suggestions build on what is already there.');
    }
    const empty = emptyFields(d);
    if (empty.length === 0) {
      return { status: 'ok', result: { edits: [], note: 'Every field is already filled — nothing to suggest.', rejectedEdits: 0 }, ai: this.status(owner) };
    }
    const pre = this.preflight(owner, n);
    if (pre) return pre;
    const hash = this.hash('strategy.suggest', { d: definitionPayload(d), e: empty });
    return this.run<StrategySuggestions>(owner, n.strategyKey, 'strategy.suggest', hash, async () =>
      parseSuggestions(await this.llm.completeJson('strategy.suggest', SUGGEST_SYSTEM_PROMPT, suggestUserTurn(d, empty), SUGGEST_SCHEMA, { userId: owner.userId }), empty),
    );
  }

  // ── internals ────────────────────────────────────────────────────────

  private requireOwner(user: AssistPrincipal | undefined): AssistPrincipal {
    if (!user || !this.llm.allowed(user)) throw new ForbiddenException('AI review is available to the account owner only.');
    return user;
  }

  /** Text guard + size cap, shared by both flows. */
  private preflight(owner: AssistPrincipal, n: NormaliseResult): AiOutcome<never> | null {
    const guard = guardStrategyText(n.definition);
    if (!guard.ok) return this.blocked(owner, 'guard', guard.message);
    if (definitionBlock(n.definition).length > DEFINITION_MAX_CHARS) {
      return this.blocked(owner, 'too-large', 'This strategy is too large to send for review. Simplify it (fewer indicators or conditions).');
    }
    return null;
  }

  private async run<T extends StrategyReview | StrategySuggestions>(
    owner: AssistPrincipal,
    strategyKey: string,
    job: AiJob,
    hash: string,
    call: () => Promise<T>,
  ): Promise<AiOutcome<T>> {
    const hit = this.governor.cached(hash);
    if (hit) return { status: 'cached', result: hit as T, ai: this.status(owner) };
    const admission = this.governor.admit(owner.userId, strategyKey, job, hash);
    if (!admission.ok) return this.blocked(owner, admission.reason, admission.message, admission.retryAfterMs);
    try {
      const result = await call();
      this.governor.succeed(admission.ticket, result);
      return { status: 'ok', result, ai: this.status(owner) };
    } catch (err) {
      if (err instanceof AssistBusyError) {
        this.governor.refund(admission.ticket);
        return { status: 'busy', message: ASSIST_BUSY_MESSAGE, ai: this.status(owner) };
      }
      this.governor.fail(admission.ticket);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${job} failed: ${msg}`);
      return { status: 'error', message: `Claude could not complete this request (${msg.slice(0, 160)}).`, ai: this.status(owner) };
    }
  }

  private blocked(owner: AssistPrincipal, reason: string, message: string, retryAfterMs?: number): AiOutcome<never> {
    return { status: 'blocked', reason, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ai: this.status(owner) };
  }

  private hash(job: AiJob, payload: unknown): string {
    return createHash('sha256').update(`${job}|${canonicalJson(payload)}`).digest('hex');
  }

  /** The user's Risk Wall limits in force, mapped to what the sizing check needs; null if unavailable. */
  private async limitsFor(user: AssistPrincipal | undefined, n: NormaliseResult): Promise<RiskLimitsView | null> {
    if (!user?.userId || !this.riskLimits) return null;
    try {
      const rows = await this.riskLimits.inForce(user.userId);
      const pick = (key: string, scope: string): number | null => {
        const row = rows.find((r) => r.key === key && r.scope === scope);
        const v = row ? Number(row.value) : NaN;
        return Number.isFinite(v) ? v : null;
      };
      const vehicle = n.definition.segment === 'OPTIONS' ? 'OPTIONS_BUY' : n.definition.segment === 'EQUITY' ? 'CASH_INTRADAY' : null;
      return {
        maxRiskPerTrade: pick('maxRiskPerTrade', 'ALL'),
        maxOpenPositions: pick('maxOpenPositions', 'ALL'),
        maxTradesPerDay: pick('maxTradesPerDay', 'ALL'),
        optionsMaxPremiumPerTrade: pick('optionsMaxPremiumPerTrade', 'OPTIONS_BUY'),
        maxCapitalDeployed: vehicle ? pick('maxCapitalDeployed', vehicle) : null,
      };
    } catch (err) {
      this.logger.warn(`risk limits unavailable for strategy check: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
