import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { NewsModule } from '../news/news.module';
import { NewsAggregatorService } from '../news/services/news-aggregator.service';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { OptionsChainService } from '../options-chain/services/options-chain.service';
import { SignalIntakeModule } from '../signal-intake/signal-intake.module';
import { SignalTraderModule } from '../signal-trader/signal-trader.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { AI_SETUPS_CONFIG, parseAiSetupsConfig, type AiSetupsConfig } from './ai-setups.config';
import { AiSetupsRepository } from './repositories/ai-setups.repository';
import { AiSetupsService } from './services/ai-setups.service';
import { SetupLlm } from './services/setup-llm.service';
import { SETUP_CHAIN_SOURCE, SETUP_NEWS_SOURCE, SETUP_PACKET_SOURCES, SetupPacketService } from './services/setup-packet.service';

/**
 * AI setups (docs/superpowers/plans/2026-11-25-ai-setups.md): a stored reading (`reader.reading.stored`) with a
 * CONFIRMED BULL / BEAR instrument claim → guards → setup packet → Opus (job setup.build) → code checks →
 * ai_setups (PENDING / NO_TRADE / SKIPPED). AI_SETUPS=off (default) | paper. There is no live mode and nothing
 * in this module imports broker order code; the paper entry / exits are a later task.
 */
@Module({
  imports: [PrismaModule, AiGatewayModule, TradeSentinelModule, MarketDataModule, SignalTraderModule, SignalIntakeModule, OptionsChainModule, NewsModule],
  providers: [
    { provide: AI_SETUPS_CONFIG, useFactory: (): AiSetupsConfig => parseAiSetupsConfig(process.env) },
    AiSetupsRepository,
    { provide: SETUP_PACKET_SOURCES, useExisting: AiSetupsRepository },
    { provide: SETUP_CHAIN_SOURCE, useExisting: OptionsChainService },
    { provide: SETUP_NEWS_SOURCE, useExisting: NewsAggregatorService },
    SetupPacketService,
    SetupLlm,
    AiSetupsService,
  ],
  exports: [AiSetupsRepository, AI_SETUPS_CONFIG],
})
export class AiSetupsModule {}
