import { MbmChainReader } from '../mbm/services/mbm-chain-reader.service';
import { ChainWatchlistService } from '../mbm/chain-watchlist';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { AI_GATEWAY, type AiGateway } from '../ai-gateway/ai-gateway.service';
import { SentinelGatewayTransport } from '../ai-gateway/sentinel/sentinel-gateway.transport';
import { AiCallRepository } from '../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../ai-gateway/audit/recorded-transport';
import type { MessagesTransport } from '../ai-gateway/transport.types';
import { MarketCuesModule } from '../market-cues/market-cues.module';
import { MarketCuesService } from '../market-cues/market-cues.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataRepository } from '../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MbmModule } from '../mbm/mbm.module';
import { MBM_CONFIG, type MbmConfig } from '../mbm/mbm.config';
import { MbmStockChainCaptureService } from '../mbm/services/mbm-stock-chain-capture.service';
import { MbmClient } from '../mbm/services/mbm-client.service';
import { ClaudeCliTransport } from '../trade-sentinel/adapters/claude-cli.transport';
import { judgeTransportFrom } from '../trade-sentinel/services/llm-transport';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import type { SessionClock } from '../market-hub/session-clock';
import { NEWS_IDEAS_JOB, NewsIdeasService } from './news-ideas.service';
import {
  SCORECARD_CHAIN_CAPTURE,
  SCORECARD_CHAINS,
  SCORECARD_LLM,
  SCORECARD_WATCHLIST,
  type BarBackfill,
  type ChainCapturer,
  type ChainReader,
  type WatchlistWriter,
} from './ports';
import { ScorecardBarBackfill } from './scorecard-bar-backfill';
import { ScorecardEngine } from './scorecard-engine';
import { parseScorecardConfig, SCORECARD_CONFIG, type ScorecardConfig } from './scorecard.config';
import { ScorecardRepository } from './scorecard.repository';
import { SCORECARD_CLOCK, SCORECARD_ENGINE, SCORECARD_NOW, ScorecardService } from './scorecard.service';

/**
 * Overnight scorecard + news ideas (docs/superpowers/specs/2026-10-20-overnight-scorecard-design.md).
 * SCORECARD_ENABLED=off|observe|on and NEWS_IDEAS_ENABLED=off|on, both default off. Reads only
 * existing tables; writes only analysis_scorecards / news_ideas. Places nothing.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, MbmModule, MarketCuesModule, AiGatewayModule],
  providers: [
    ScorecardRepository,
    { provide: SCORECARD_CONFIG, useFactory: () => parseScorecardConfig(process.env) },
    { provide: SCORECARD_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    { provide: SCORECARD_NOW, useValue: () => new Date() },
    // Stream A's per-symbol chain reader / watchlist: stubs until mbm/chain-watchlist.ts is merged.
    // Stream A (per-symbol chain capture): real chain reads + news-scan watchlist registrations.
    {
      provide: SCORECARD_CHAINS,
      useFactory: (r: MbmChainReader): ChainReader => ({
        latest: (symbol) => r.latestChain(symbol),
        history: (symbol, sessions) => r.chainHistory(symbol, sessions),
      }),
      inject: [MbmChainReader],
    },
    {
      provide: SCORECARD_WATCHLIST,
      useFactory: (w: ChainWatchlistService): WatchlistWriter => ({
        add: async (symbols, ttlHours) => {
          w.add(symbols, ttlHours);
        },
      }),
      inject: [ChainWatchlistService],
    },
    {
      // News-idea candidates' chains captured on demand before scoring (same flag/session as stream A's tick).
      provide: SCORECARD_CHAIN_CAPTURE,
      useFactory: (c: MbmStockChainCaptureService): ChainCapturer => ({ captureFor: (symbols) => c.captureNow(symbols) }),
      inject: [MbmStockChainCaptureService],
    },
    {
      provide: SCORECARD_ENGINE,
      useFactory: (
        repo: ScorecardRepository,
        chains: ChainReader,
        cues: MarketCuesService,
        mood: MbmClient,
        clock: SessionClock,
        feeds: UserFeedManager,
        candles: MarketDataRepository,
        mbm: MbmConfig,
        cfg: ScorecardConfig,
      ) => {
        // Short `candles` history is fetched on demand over the owner's own Angel session (the MBM
        // feed user, as the chain capture uses) and persisted into `candles`.
        const backfill: BarBackfill = new ScorecardBarBackfill(repo, feeds, candles, mbm.feedUserId ?? cfg.ownerUserId);
        return new ScorecardEngine(repo, chains, cues, mood, clock, backfill);
      },
      inject: [
        ScorecardRepository,
        SCORECARD_CHAINS,
        MarketCuesService,
        MbmClient,
        SCORECARD_CLOCK,
        UserFeedManager,
        MarketDataRepository,
        MBM_CONFIG,
        SCORECARD_CONFIG,
      ],
    },
    {
      // The same transport choice as the sentinel's ANTHROPIC_CLIENT (trade-sentinel.module.ts):
      // AI_GATEWAY_SENTINEL=true → the gateway (labelled `sentinel.unknown`, routed by SENTINEL_JUDGE);
      // else SENTINEL_JUDGE=cli → the local claude CLI; else the Anthropic API. Flag off, the direct
      // transport writes one `ai_calls` row per call (job `news.ideas`), fire-and-forget;
      // AI_CALLS_RECORD=off binds the bare transport.
      provide: SCORECARD_LLM,
      useFactory: (config: ConfigService, cli: ClaudeCliTransport, gateway: AiGateway, calls: AiCallRepository): MessagesTransport =>
        config.get<string>('AI_GATEWAY_SENTINEL')?.trim().toLowerCase() === 'true'
          ? new SentinelGatewayTransport(gateway)
          : directRecordedTransport({
              judge: judgeTransportFrom(config.get<string>('SENTINEL_JUDGE')),
              cli,
              apiKey: config.get<string>('ANTHROPIC_API_KEY'),
              record: aiCallsRecordingOn(config.get<string>('AI_CALLS_RECORD')),
              audit: calls,
              jobOf: () => NEWS_IDEAS_JOB,
            }),
      inject: [ConfigService, ClaudeCliTransport, AI_GATEWAY, AiCallRepository],
    },
    ScorecardService,
    NewsIdeasService,
  ],
  exports: [ScorecardService, NewsIdeasService],
})
export class OvernightScorecardModule {}
