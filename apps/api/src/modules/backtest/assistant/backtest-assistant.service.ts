import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StrategyExecutorService } from '../../signal-generator/services/strategy-executor.service';
import type { AssistPrincipal } from '../../ai-assist/assist-llm.service';
import { BacktestRepository } from '../repositories/backtest.repository';
import { BacktestDataRepository } from '../repositories/backtest-data.repository';
import { BacktestDataService } from '../services/backtest-data.service';
import { DataAcquisitionService, type AcquireResult } from '../services/data-acquisition.service';
import { istMidnight, IST_OFFSET_MS } from '../data/backtest-data.domain';
import { classifyBacktestRequest, normaliseRequest } from './backtest-guardrail';
import { BACKTEST_SPEC_SCHEMA, DEFAULT_MAX_BARS, describeSpec, validateSpec, type ValidSpec } from './backtest-spec';
import { computeAggregates } from './backtest-metrics';
import { SPEC_SYSTEM_PROMPT, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, specUserTurn, summaryUserTurn } from './backtest-prompts';
import { BacktestLlmService } from './backtest-llm.service';

export const ASSISTANT_CLOCK = Symbol('ASSISTANT_CLOCK');

export interface AssistantConfig {
  /** BACKTEST_AI_DAILY_CAP: requests per IST day that spend a model call (cache hits are free). */
  dailyCap: number;
  /** BACKTEST_AI_CACHE_HOURS: a finished identical request this recent is replayed for free. */
  cacheHours: number;
  /** BACKTEST_AI_SUMMARY_MAX_CHARS: cap on the summary prompt's data block. */
  summaryMaxChars: number;
  /** BACKTEST_COST_BPS_PER_SIDE: flat cost estimate per side, in basis points of notional. */
  costBpsPerSide: number;
  /** BACKTEST_MAX_BARS: bars one assistant backtest may read. */
  maxBars: number;
}

const num = (raw: string | undefined, fallback: number, min = 0) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export function readAssistantConfig(get: (k: string) => string | undefined): AssistantConfig {
  return {
    dailyCap: Math.floor(num(get('BACKTEST_AI_DAILY_CAP'), 20, 0)),
    cacheHours: num(get('BACKTEST_AI_CACHE_HOURS'), 24, 0),
    summaryMaxChars: Math.floor(num(get('BACKTEST_AI_SUMMARY_MAX_CHARS'), 6000, 500)),
    costBpsPerSide: num(get('BACKTEST_COST_BPS_PER_SIDE'), 3, 0),
    maxBars: Math.floor(num(get('BACKTEST_MAX_BARS'), DEFAULT_MAX_BARS, 1000)),
  };
}

export function requestHash(prompt: string): string {
  return createHash('sha256').update(normaliseRequest(prompt)).digest('hex');
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IN_FLIGHT = ['queued', 'spec', 'fetching', 'running', 'summarising'];

/**
 * "Ask Claude to backtest…" (owner only):
 *   guard (deterministic) → cache / in-flight / daily cap → Claude #1: request → spec (strict JSON,
 *   the Strategy Builder's vocabulary only) → validate → fetch missing data (DataAcquisitionService)
 *   → deterministic engine (StrategyExecutorService) → aggregates → Claude #2: short summary of the
 *   aggregates only → done. State lives in backtest_ai_requests; the page polls it.
 */
@Injectable()
export class BacktestAssistantService {
  private readonly logger = new Logger(BacktestAssistantService.name);
  private readonly cfg: AssistantConfig;

  constructor(
    config: ConfigService,
    private readonly llm: BacktestLlmService,
    private readonly repo: BacktestDataRepository,
    private readonly runs: BacktestRepository,
    private readonly data: BacktestDataService,
    private readonly acquisition: DataAcquisitionService,
    private readonly executor: StrategyExecutorService,
    @Optional() @Inject(ASSISTANT_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {
    this.cfg = readAssistantConfig((k) => config.get<string>(k));
  }

  private assertOwner(user: AssistPrincipal | undefined): asserts user is AssistPrincipal {
    if (!this.llm.allowed(user)) throw new ForbiddenException('The backtest assistant is available to the owner only.');
  }

  async status(user: AssistPrincipal | undefined) {
    if (!this.llm.allowed(user)) return { allowed: false as const };
    const usedToday = await this.repo.aiRequestsWithLlmSince(user!.userId, new Date(istMidnight(this.now())));
    return {
      allowed: true as const,
      dailyCap: this.cfg.dailyCap,
      usedToday,
      fetchLimits: this.acquisition.limits,
      maxBars: this.cfg.maxBars,
    };
  }

  async get(user: AssistPrincipal | undefined, id: string) {
    this.assertOwner(user);
    const row = await this.repo.getAiRequest(id);
    if (!row || row.userId !== user.userId) throw new NotFoundException('request not found');
    return row;
  }

  async recent(user: AssistPrincipal | undefined) {
    this.assertOwner(user);
    return this.repo.recentAiRequests(user.userId, 10);
  }

  /** Starts a request; returns its row at once (the work continues in the background). */
  async ask(user: AssistPrincipal | undefined, prompt: string) {
    this.assertOwner(user);
    const text = (prompt ?? '').trim();
    const hash = requestHash(text);
    const verdict = classifyBacktestRequest(text);
    if (!verdict.allowed) {
      return this.repo.createAiRequest({ userId: user.userId, requestHash: hash, prompt: text.slice(0, 1000), status: 'refused', error: verdict.message });
    }
    const now = this.now();
    const inflight = await this.repo.findInflightAiRequest(user.userId, hash, new Date(now.getTime() - 30 * 60_000));
    if (inflight) return inflight;
    if (this.cfg.cacheHours > 0) {
      const hit = await this.repo.findCachedAiRequest(hash, new Date(now.getTime() - this.cfg.cacheHours * 3_600_000));
      if (hit) {
        const row = await this.repo.createAiRequest({ userId: user.userId, requestHash: hash, prompt: text, status: 'done' });
        return this.repo.updateAiRequest(row.id, {
          spec: hit.spec ?? undefined,
          metrics: hit.metrics ?? undefined,
          progress: hit.progress ?? undefined,
          summary: hit.summary,
          runId: hit.runId,
          cachedFrom: hit.id,
        });
      }
    }
    const used = await this.repo.aiRequestsWithLlmSince(user.userId, new Date(istMidnight(now)));
    if (used >= this.cfg.dailyCap) {
      return this.repo.createAiRequest({
        userId: user.userId,
        requestHash: hash,
        prompt: text,
        status: 'refused',
        error: `Daily limit reached (${this.cfg.dailyCap} Claude backtests per day). Identical requests within ${this.cfg.cacheHours} h are still served from cache.`,
      });
    }
    const row = await this.repo.createAiRequest({ userId: user.userId, requestHash: hash, prompt: text, status: 'queued' });
    void this.process(row.id, user.userId, text).catch((err) => this.logger.error(`[backtest-ai] ${row.id} crashed: ${errText(err)}`));
    return row;
  }

  /** The pipeline. Every exit writes a terminal status; never throws. */
  async process(id: string, userId: string, prompt: string): Promise<void> {
    let llmCalls = 0;
    const set = (data: Parameters<BacktestDataRepository['updateAiRequest']>[1]) => this.repo.updateAiRequest(id, data);
    try {
      // 1. request → spec
      await set({ status: 'spec' });
      const todayIst = new Date(this.now().getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
      let raw: unknown;
      try {
        llmCalls++;
        await set({ llmCalls });
        raw = await this.llm.completeJson('backtest.spec', SPEC_SYSTEM_PROMPT, specUserTurn(prompt, todayIst), BACKTEST_SPEC_SCHEMA, {
          userId,
          maxTokens: 2_000,
          effort: 'medium',
        });
      } catch (err) {
        await set({ status: 'error', error: `Could not build a backtest spec: ${errText(err)}` });
        return;
      }
      const verdict = validateSpec(raw, this.now(), this.cfg.maxBars);
      if (!verdict.ok) {
        await set({
          status: verdict.infeasible ? 'refused' : 'error',
          spec: (raw ?? undefined) as any,
          error: verdict.infeasible
            ? `Can't express this as a backtest here: ${verdict.errors[0]}`
            : `The spec did not validate: ${verdict.errors.slice(0, 6).join('; ')}`,
        });
        return;
      }
      const v = verdict.value;
      const described = describeSpec(v);
      await set({ spec: { ...v.spec, resolved: { from: v.from.toISOString(), to: v.to.toISOString(), described } } as any });

      // 2. data
      await set({ status: 'fetching', progress: { phase: 'checking data' } });
      let fetch: AcquireResult | null = null;
      try {
        fetch = await this.acquisition.acquire(
          userId,
          { symbol: v.spec.symbol, exchange: v.spec.exchange, timeframe: v.spec.timeframe, from: v.from, to: v.to },
          (p) => set({ progress: { ...p } }).then(() => undefined),
        );
      } catch (err) {
        fetch = { status: 'error', calls: 0, rows: 0, message: errText(err) };
      }

      // 3. engine
      await set({ status: 'running', progress: { phase: 'running', fetch: fetch as any } });
      const stored = await this.data.loadFromStore(v.spec.symbol, v.spec.exchange, v.spec.timeframe, v.from, v.to, this.cfg.maxBars);
      if (!stored || stored.candles.length < 30) {
        await set({
          status: 'error',
          error: `No usable ${v.spec.timeframe} data for ${v.spec.symbol}${fetch ? ` (data fetch: ${fetch.status} — ${fetch.message})` : ''}.`,
        });
        return;
      }
      if (stored.candles.length > this.cfg.maxBars) {
        await set({ status: 'error', error: `More than ${this.cfg.maxBars} bars in this period; shorten it or use a coarser timeframe.` });
        return;
      }
      const result = this.executor.executeBacktest(v.parsed, stored.candles, v.initialCapital, v.positionSizePct);
      const agg = computeAggregates(result.trades, v.initialCapital, v.positionSizePct, this.cfg.costBpsPerSide);
      const dataInfo = {
        source: stored.source,
        bars: stored.candles.length,
        firstBar: stored.candles[0].timestamp.toISOString(),
        lastBar: stored.candles[stored.candles.length - 1].timestamp.toISOString(),
        partial: !stored.complete,
        fetch: fetch ? { status: fetch.status, provider: fetch.provider ?? null, calls: fetch.calls, rows: fetch.rows, message: fetch.message } : null,
      };
      const run = await this.runs.saveBacktestRun({
        strategy: v.parsed.name,
        parameters: {
          symbol: v.spec.symbol,
          exchange: v.spec.exchange,
          timeframe: v.spec.timeframe,
          initialCapital: v.initialCapital,
          positionSize: v.positionSizePct,
          source: 'backtest-assistant',
          requestId: id,
          spec: described,
        },
        startDate: v.from,
        endDate: v.to,
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalReturn: result.totalReturn,
        maxDrawdown: result.maxDrawdown,
        sharpeRatio: result.sharpeRatio,
        results: result,
      });
      await set({ runId: run.id, metrics: { ...agg, data: dataInfo } as any });

      // 4. summary (aggregates only; a failure here still leaves the metrics)
      await set({ status: 'summarising' });
      let summary: string | null = null;
      let note: string | null = null;
      try {
        llmCalls++;
        await set({ llmCalls });
        const reply = (await this.llm.completeJson(
          'backtest.summary',
          SUMMARY_SYSTEM_PROMPT,
          summaryUserTurn({ strategy: described, assumptions: v.spec.assumptions, data: dataInfo, ...agg }, this.cfg.summaryMaxChars),
          SUMMARY_SCHEMA,
          { userId, maxTokens: 1_200, effort: 'low' },
        )) as { summary?: unknown; caveats?: unknown; verdict?: unknown };
        const caveats = Array.isArray(reply?.caveats) ? reply.caveats.map(String).slice(0, 5) : [];
        summary = [
          typeof reply?.verdict === 'string' ? `**Verdict: ${reply.verdict}**` : null,
          typeof reply?.summary === 'string' ? reply.summary.trim() : null,
          caveats.length ? caveats.map((c) => `- ${c}`).join('\n') : null,
        ].filter(Boolean).join('\n\n') || null;
      } catch (err) {
        note = `Summary unavailable: ${errText(err)}`;
      }
      await set({ status: 'done', summary, error: note, progress: { phase: 'done', fetch: dataInfo.fetch as any } });
    } catch (err) {
      this.logger.error(`[backtest-ai] ${id} failed: ${errText(err)}`);
      await this.repo.updateAiRequest(id, { status: 'error', error: `Backtest failed: ${errText(err)}` }).catch(() => undefined);
    }
  }

  /** In-flight check for tests / the controller. */
  static isInFlight(status: string): boolean {
    return IN_FLIGHT.includes(status);
  }
}

export type { ValidSpec };
