import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { priorityOf, type AiJob } from './ai-job';
import type { AiRoute } from './routes/route-config';
import { costInr, worstCaseInr, type ModelPrice } from './budget/model-prices';
import { AiBudgetExceeded, type BudgetMeter, type BudgetReservation } from './budget/budget-meter';
import { AiQueueTimeout, type PriorityScheduler } from './scheduler/priority-scheduler';
import type { AiCallRow } from './audit/ai-call.repository';
import type { ProviderAdapter, ProviderName, ProviderResult } from './providers/provider.types';
import type { TransportMessage, TransportRequest } from './transport.types';

export const AI_GATEWAY = 'AI_GATEWAY';

export interface AiCallContext {
  userId?: string;
  positionId?: string;
  setupId?: string;
  decisionRecordId?: string;
}

/** The one door every LLM call goes through (spec §4.1). */
export interface AiGateway {
  call(job: AiJob, request: TransportRequest, ctx?: AiCallContext): Promise<TransportMessage>;
}

export interface AiGatewayStats {
  auditWriteFailures: number;
  budgetRefusals: number;
  queueTimeouts: number;
}

export interface AiGatewayDeps {
  routes: Record<AiJob, AiRoute>;
  prices: Map<string, ModelPrice>;
  meter: BudgetMeter;
  scheduler: PriorityScheduler;
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  audit: { insert(row: AiCallRow): Promise<void> };
}

/** Providers that spend metered credit and therefore pass through the budget meter. */
const BILLED: ReadonlySet<ProviderName> = new Set<ProviderName>(['anthropic-api']);

const ERROR_MESSAGE_MAX = 2000;

/**
 * Routes, schedules, budgets and records every LLM call (spec §4).
 *
 * BEHAVIOUR-PRESERVING FOR THE SENTINEL. A route with `model: null` (every
 * `sentinel.*` route) hands the caller's request object to the provider
 * UNCHANGED — same reference, no copy — and returns the provider's message by
 * reference. Errors are rethrown as the original instance, so the sentinel's
 * error classification sees exactly what it saw before. Sentinel routes have no
 * fallback.
 *
 * AUDIT IS FIRE-AND-FORGET. The `ai_calls` write starts after the provider has
 * answered and is never awaited on the caller's path: a slow, hung or failing
 * database cannot delay, change or fail the result. A failed write is logged
 * once and counted in `stats().auditWriteFailures`.
 *
 * BUDGET IS RESERVED SYNCHRONOUSLY. For a billed provider the worst-case cost
 * is reserved in one synchronous step before the call is sent (see
 * `BudgetMeter`), so concurrent calls can never jointly exceed the cap. An
 * unknown model price, an unloadable spend ledger or an exhausted cap all
 * refuse the call with `AiBudgetExceeded` — fail closed on spend.
 */
export class AiGatewayService implements AiGateway {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly counters: AiGatewayStats = { auditWriteFailures: 0, budgetRefusals: 0, queueTimeouts: 0 };

  constructor(private readonly deps: AiGatewayDeps) {}

  stats(): AiGatewayStats {
    return { ...this.counters };
  }

  async call(job: AiJob, request: TransportRequest, ctx: AiCallContext = {}): Promise<TransportMessage> {
    const route = this.deps.routes[job];
    if (!route) throw new Error(`ai-gateway: no route for job ${job}`);
    const priority = priorityOf(job);
    const chain: ProviderName[] = [route.provider, ...route.fallback];
    let fallbackFrom: ProviderName | null = null;

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isLast = i === chain.length - 1;
      const req: TransportRequest = route.model ? { ...request, model: route.model } : request;
      const base = { job, provider, priority, ctx, req, fallbackFrom };

      const adapter = this.deps.adapters[provider];
      if (!adapter) {
        const err = new Error(`ai-gateway: provider ${provider} is not configured`);
        this.audit(base, { error: err, latencyMs: 0, queuedMs: 0 });
        if (!isLast) {
          fallbackFrom = provider;
          continue;
        }
        throw err;
      }

      let price: ModelPrice | undefined;
      let reservation: BudgetReservation | undefined;
      if (BILLED.has(provider)) {
        try {
          price = this.deps.prices.get(req.model);
          if (!price) throw new AiBudgetExceeded(`unknown price for ${req.model}`);
          try {
            await this.deps.meter.refresh();
          } catch (loadErr) {
            throw new AiBudgetExceeded(
              `ai budget: today's spend could not be loaded: ${(loadErr as Error)?.message ?? String(loadErr)}`,
            );
          }
          reservation = this.deps.meter.reserve(job, worstCaseInr(price, req));
        } catch (err) {
          this.counters.budgetRefusals++;
          this.audit(base, { error: err, latencyMs: 0, queuedMs: 0 });
          throw err;
        }
      }

      const startedAt = Date.now();
      try {
        const { result, queuedMs } = await this.deps.scheduler.run(provider, priority, route.maxWaitMs, () =>
          adapter.send(req),
        );
        const latencyMs = Math.max(0, Date.now() - startedAt - queuedMs);
        // Unreported counts price as 0 (nothing is estimated); the reported
        // ones, cache writes/reads included, are in the stored `response.usage`.
        const cost = price
          ? costInr(
              price,
              result.meta.inputTokens ?? 0,
              result.meta.outputTokens ?? 0,
              result.meta.cacheCreationInputTokens ?? 0,
              result.meta.cacheReadInputTokens ?? 0,
            )
          : 0;
        reservation?.settle(cost);
        this.audit(base, { result, cost, latencyMs, queuedMs });
        return result.message;
      } catch (err) {
        reservation?.release();
        if (err instanceof AiQueueTimeout) this.counters.queueTimeouts++;
        const elapsed = Math.max(0, Date.now() - startedAt);
        this.audit(base, {
          error: err,
          latencyMs: err instanceof AiQueueTimeout ? 0 : elapsed,
          queuedMs: err instanceof AiQueueTimeout ? elapsed : 0,
        });
        if (!isLast) {
          fallbackFrom = provider;
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns or throws on its last provider.
    throw new Error(`ai-gateway: empty provider chain for ${job}`);
  }

  /**
   * Build and write one `ai_calls` row without ever affecting the caller.
   * Synchronous throws (building the row, a repository that throws instead of
   * rejecting) and rejections are both caught, logged once and counted.
   */
  private audit(
    base: {
      job: AiJob;
      provider: ProviderName;
      priority: number;
      ctx: AiCallContext;
      req: TransportRequest;
      fallbackFrom: ProviderName | null;
    },
    outcome:
      | { result: ProviderResult; cost: number; latencyMs: number; queuedMs: number }
      | { error: unknown; latencyMs: number; queuedMs: number },
  ): void {
    const fail = (err: unknown): void => {
      this.counters.auditWriteFailures++;
      this.logger.error(
        `ai-gateway: audit write failed (${base.job}): ${(err as Error)?.message ?? String(err)}`,
      );
    };
    try {
      const json = JSON.stringify(base.req);
      const ok = 'result' in outcome ? outcome.result : null;
      const err = 'error' in outcome ? outcome.error : null;
      const row: AiCallRow = {
        job: base.job,
        provider: base.provider,
        model: base.req.model,
        effort: base.req.output_config?.effort ?? null,
        priority: base.priority,
        userId: base.ctx.userId ?? null,
        positionId: base.ctx.positionId ?? null,
        setupId: base.ctx.setupId ?? null,
        decisionRecordId: base.ctx.decisionRecordId ?? null,
        requestHash: createHash('sha256').update(json).digest('hex'),
        request: base.req,
        response: ok ? ok.message : null,
        errorClass: err === null ? null : errorClass(err),
        errorMessage: err === null ? null : errorMessage(err),
        stopReason: ok ? ok.message.stop_reason : null,
        inputTokens: ok ? ok.meta.inputTokens : null,
        outputTokens: ok ? ok.meta.outputTokens : null,
        costInr: ok && 'cost' in outcome ? outcome.cost : 0,
        latencyMs: Math.round(outcome.latencyMs),
        queuedMs: Math.round(outcome.queuedMs),
        fallbackFrom: base.fallbackFrom,
      };
      this.deps.audit.insert(row).catch(fail);
    } catch (e) {
      fail(e);
    }
  }
}

function errorClass(err: unknown): string {
  if (err && typeof err === 'object' && err.constructor && err.constructor.name) {
    return err.constructor.name;
  }
  return typeof err;
}

function errorMessage(err: unknown): string {
  const msg = err && typeof err === 'object' && 'message' in err ? (err as Error).message : err;
  return String(msg).slice(0, ERROR_MESSAGE_MAX);
}
