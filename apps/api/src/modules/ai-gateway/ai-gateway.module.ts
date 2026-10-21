import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AI_GATEWAY, AiGatewayService } from './ai-gateway.service';
import { AiCallRepository } from './audit/ai-call.repository';
import { AiCallsSizeWatch } from './audit/ai-calls-size-watch.service';
import { BudgetMeter, istDayKey } from './budget/budget-meter';
import { loadPrices } from './budget/model-prices';
import { AnthropicApiProvider } from './providers/anthropic-api.provider';
import { ClaudeCliProvider, ClaudeCliTransport } from './providers/claude-cli.provider';
import { loadRoutes, readAiConfig } from './routes/route-config';
import { PriorityScheduler } from './scheduler/priority-scheduler';
import { ScorerClient } from './scorer/scorer.client';

/** Share of the daily cap reserved for position-review jobs (spec §4.5). */
const REVIEW_RESERVE_SHARE = 0.25;
const DEFAULT_DAILY_CAP_INR = 100;
const DEFAULT_CLI_CONCURRENCY = 2;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * With `AI_GATEWAY_SENTINEL=true` every sentinel CLI call queues on the
 * scheduler's `claude-cli` limit, and the sentinel alone runs up to
 * `JUDGE_CONCURRENCY` (2) judgements plus thesis calls. Below 3 a thesis call
 * waits behind both judges (a CLI call can run 180 s) — a delay the direct,
 * unscheduled binding never had.
 */
export const SENTINEL_MIN_CLI_CONCURRENCY = 3;

/**
 * The `claude-cli` concurrency limit: `AI_CLI_CONCURRENCY` when it is a whole
 * number ≥ 1 (else the default — a 0 limit would queue every call forever),
 * floored at {@link SENTINEL_MIN_CLI_CONCURRENCY} while the sentinel is routed
 * through the gateway.
 */
export function cliConcurrency(raw: string | undefined, gatewaySentinel: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const base = Number.isInteger(n) && n >= 1 ? n : DEFAULT_CLI_CONCURRENCY;
  return gatewaySentinel?.trim() === 'true' ? Math.max(base, SENTINEL_MIN_CLI_CONCURRENCY) : base;
}

/** Midnight IST of the day containing `now`, as an instant. */
export function istMidnight(now: Date): Date {
  return new Date(`${istDayKey(now)}T00:00:00+05:30`);
}

/**
 * The AI Gateway (SP3 M1): one door for every LLM call — routing, priority,
 * daily API budget and the `ai_calls` ledger.
 *
 * `ClaudeCliTransport` is provided HERE and exported, so the sentinel's
 * flag-off binding and the gateway's `claude-cli` provider share ONE instance
 * (one temp dir, one prompt-file cache).
 *
 * Config files (`config/ai-routes.json`, `config/ai-model-prices.json`) are
 * read at module init; a missing or malformed file fails boot loudly.
 *
 * With `AI_GATEWAY_SENTINEL=true` the `claude-cli` limit is floored at 3 — see
 * {@link cliConcurrency}.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ClaudeCliTransport,
    AiCallRepository,
    {
      provide: AiGatewayService,
      useFactory: (config: ConfigService, cli: ClaudeCliTransport, repo: AiCallRepository): AiGatewayService => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SENTINEL_JUDGE: config.get<string>('SENTINEL_JUDGE'),
        };
        const routes = loadRoutes(readAiConfig('ai-routes.json'), env);
        const prices = loadPrices(readAiConfig('ai-model-prices.json'));
        const meter = new BudgetMeter({
          capInr: positiveNumber(config.get<string>('AI_API_DAILY_CAP_INR'), DEFAULT_DAILY_CAP_INR),
          reserveShare: REVIEW_RESERVE_SHARE,
          spentToday: () => repo.spentSince(istMidnight(new Date())),
          now: () => new Date(),
        });
        const scheduler = new PriorityScheduler({
          'claude-cli': cliConcurrency(
            config.get<string>('AI_CLI_CONCURRENCY'),
            config.get<string>('AI_GATEWAY_SENTINEL'),
          ),
        });
        return new AiGatewayService({
          routes,
          prices,
          meter,
          scheduler,
          adapters: {
            'claude-cli': new ClaudeCliProvider(cli),
            'anthropic-api': new AnthropicApiProvider(
              new Anthropic({ apiKey: config.get<string>('ANTHROPIC_API_KEY') }),
            ),
          },
          audit: repo,
        });
      },
      inject: [ConfigService, ClaudeCliTransport, AiCallRepository],
    },
    { provide: AI_GATEWAY, useExisting: AiGatewayService },
    // Node -> ai-engine /score at AI_SCORER_URL (not AI_ENGINE_URL). Fail-open; nothing calls it yet (SP3 M2).
    ScorerClient,
    // Daily ai_calls size log + warning (no retention exists; the table is append-only).
    AiCallsSizeWatch,
  ],
  exports: [AI_GATEWAY, AiGatewayService, ClaudeCliTransport, ScorerClient, AiCallRepository],
})
export class AiGatewayModule {}
