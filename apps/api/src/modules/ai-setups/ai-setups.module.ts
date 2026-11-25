import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { EntryEnginePaperService } from '../entry-engine/entry-engine-paper.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MARKET_QUOTE_RESOLVER, type QuoteResolverLike } from '../market-data/services/batch-quotes.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { parseLateClose, SessionClock } from '../market-hub/session-clock';
import { NewsModule } from '../news/news.module';
import { NewsAggregatorService } from '../news/services/news-aggregator.service';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { OptionsChainService } from '../options-chain/services/options-chain.service';
import { SignalIntakeModule } from '../signal-intake/signal-intake.module';
import { SIGNAL_INFO_BARS, SIGNAL_INFO_MASTER, type InfoBars } from '../signal-intake/services/signal-outcome.service';
import { SignalVocabularyService } from '../signal-intake/services/signal-vocabulary.service';
import type { SignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SIGNAL_TRADER_CONFIG } from '../signal-trader/services/signal-trader.service';
import { SignalTraderModule } from '../signal-trader/signal-trader.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { AI_SETUPS_CONFIG, parseAiSetupsConfig, type AiSetupsConfig } from './ai-setups.config';
import { AiSetupsController } from './controllers/ai-setups.controller';
import { AiSetupsRepository } from './repositories/ai-setups.repository';
import { AiSetupsService } from './services/ai-setups.service';
import { AI_SETUP_GRADE_CLOCK, SetupGradeCron } from './services/setup-grade.cron';
import { SetupLlm } from './services/setup-llm.service';
import { SETUP_CHAIN_SOURCE, SETUP_NEWS_SOURCE, SETUP_PACKET_SOURCES, SetupPacketService } from './services/setup-packet.service';
import { LiveSetupWatchMarket } from './services/setup-watch.market';
import { SETUP_WATCH_MARKET, SetupWatchService, type SetupWatchMarket } from './services/setup-watch.service';

/**
 * AI setups (docs/superpowers/plans/2026-11-25-ai-setups.md): a stored reading (`reader.reading.stored`) with a
 * CONFIRMED BULL / BEAR instrument claim → guards → setup packet → Opus (job setup.build) → code checks →
 * ai_setups (PENDING / NO_TRADE / SKIPPED). AI_SETUPS=off (default) | paper. There is no live mode and nothing
 * in this module imports broker order code. The setup watch (SetupWatchService) fills a PENDING setup as a PAPER
 * option trade through the entry engine's paper path (EntryEnginePaperService, isPaper: true — provided here, as
 * the re-entry watch does) and closes it on the underlying's levels (TradeExecutionService.closeTrade, paper only).
 */
@Module({
  controllers: [AiSetupsController],
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule, MarketDataModule, SignalTraderModule, SignalIntakeModule, OptionsChainModule, NewsModule, TradeEngineModule],
  providers: [
    { provide: AI_SETUPS_CONFIG, useFactory: (): AiSetupsConfig => parseAiSetupsConfig(process.env) },
    AiSetupsRepository,
    { provide: SETUP_PACKET_SOURCES, useExisting: AiSetupsRepository },
    { provide: SETUP_CHAIN_SOURCE, useExisting: OptionsChainService },
    { provide: SETUP_NEWS_SOURCE, useExisting: NewsAggregatorService },
    SetupPacketService,
    SetupLlm,
    AiSetupsService,
    EntryEnginePaperService,
    {
      // Quotes / 15m bars / master / session clock over the owner's session — never an order.
      provide: SETUP_WATCH_MARKET,
      useFactory: (
        moduleRef: ModuleRef,
        quotes: QuoteResolverLike,
        bars: InfoBars | null,
        master: { rows(): Promise<readonly unknown[] | null> } | null,
        vocab: SignalVocabularyService | null,
        trader: SignalTraderConfig,
        config: ConfigService,
      ): SetupWatchMarket =>
        new LiveSetupWatchMarket({
          moduleRef,
          quotes,
          bars: bars ?? null,
          master: master ?? null,
          vocab: vocab ?? null,
          ownerUserId: trader.ownerUserId ?? null,
          clock: new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }),
        }),
      inject: [ModuleRef, MARKET_QUOTE_RESOLVER, SIGNAL_INFO_BARS, SIGNAL_INFO_MASTER, SignalVocabularyService, SIGNAL_TRADER_CONFIG, ConfigService],
    },
    SetupWatchService,
    // Nightly grading (18:40 NSE / 23:45 MCX IST) on the trading-day calendar.
    { provide: AI_SETUP_GRADE_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    SetupGradeCron,
  ],
  exports: [AiSetupsRepository, AI_SETUPS_CONFIG],
})
export class AiSetupsModule {}
