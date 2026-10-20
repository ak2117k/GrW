import Anthropic from '@anthropic-ai/sdk';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { AI_GATEWAY, type AiGateway } from '../ai-gateway/ai-gateway.service';
import { SentinelGatewayTransport } from '../ai-gateway/sentinel/sentinel-gateway.transport';
import type { MessagesTransport } from '../ai-gateway/transport.types';
import { MarketCuesModule } from '../market-cues/market-cues.module';
import { MarketCuesService } from '../market-cues/market-cues.service';
import { MbmModule } from '../mbm/mbm.module';
import { MbmClient } from '../mbm/services/mbm-client.service';
import { ClaudeCliTransport } from '../trade-sentinel/adapters/claude-cli.transport';
import { judgeTransportFrom } from '../trade-sentinel/services/llm-transport';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import type { SessionClock } from '../market-hub/session-clock';
import { NewsIdeasService } from './news-ideas.service';
import { NOOP_WATCHLIST, SCORECARD_CHAINS, SCORECARD_LLM, SCORECARD_WATCHLIST, UNAVAILABLE_CHAINS, type ChainReader } from './ports';
import { ScorecardEngine } from './scorecard-engine';
import { parseScorecardConfig, SCORECARD_CONFIG } from './scorecard.config';
import { ScorecardRepository } from './scorecard.repository';
import { SCORECARD_CLOCK, SCORECARD_ENGINE, SCORECARD_NOW, ScorecardService } from './scorecard.service';

/**
 * Overnight scorecard + news ideas (docs/superpowers/specs/2026-10-20-overnight-scorecard-design.md).
 * SCORECARD_ENABLED=off|observe|on and NEWS_IDEAS_ENABLED=off|on, both default off. Reads only
 * existing tables; writes only analysis_scorecards / news_ideas. Places nothing.
 */
@Module({
  imports: [PrismaModule, MbmModule, MarketCuesModule, AiGatewayModule],
  providers: [
    ScorecardRepository,
    { provide: SCORECARD_CONFIG, useFactory: () => parseScorecardConfig(process.env) },
    { provide: SCORECARD_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    { provide: SCORECARD_NOW, useValue: () => new Date() },
    // Stream A's per-symbol chain reader / watchlist: stubs until mbm/chain-watchlist.ts is merged.
    { provide: SCORECARD_CHAINS, useValue: UNAVAILABLE_CHAINS },
    { provide: SCORECARD_WATCHLIST, useValue: NOOP_WATCHLIST },
    {
      provide: SCORECARD_ENGINE,
      useFactory: (repo: ScorecardRepository, chains: ChainReader, cues: MarketCuesService, mood: MbmClient, clock: SessionClock) =>
        new ScorecardEngine(repo, chains, cues, mood, clock),
      inject: [ScorecardRepository, SCORECARD_CHAINS, MarketCuesService, MbmClient, SCORECARD_CLOCK],
    },
    {
      // The same transport choice as the sentinel's ANTHROPIC_CLIENT (trade-sentinel.module.ts):
      // AI_GATEWAY_SENTINEL=true → the gateway (labelled `sentinel.unknown`, routed by SENTINEL_JUDGE);
      // else SENTINEL_JUDGE=cli → the local claude CLI; else the Anthropic API.
      provide: SCORECARD_LLM,
      useFactory: (config: ConfigService, cli: ClaudeCliTransport, gateway: AiGateway): MessagesTransport =>
        config.get<string>('AI_GATEWAY_SENTINEL')?.trim().toLowerCase() === 'true'
          ? new SentinelGatewayTransport(gateway)
          : judgeTransportFrom(config.get<string>('SENTINEL_JUDGE')) === 'cli'
            ? cli
            : (new Anthropic({ apiKey: config.get<string>('ANTHROPIC_API_KEY') }) as unknown as MessagesTransport),
      inject: [ConfigService, ClaudeCliTransport, AI_GATEWAY],
    },
    ScorecardService,
    NewsIdeasService,
  ],
  exports: [ScorecardService],
})
export class OvernightScorecardModule {}
