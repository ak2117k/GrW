import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AngelOneAdapterService } from '../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { CredentialVaultModule } from '../credential-vault/credential-vault.module';
import { BrokerOverviewService } from '../credential-vault/services/broker-overview.service';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { OwnerBrokerSessionProvider } from '../sentinel-executor/services/owner-broker-session.provider';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { MbmModule } from '../mbm/mbm.module';
import { parseSignalTraderConfig } from './domain/signal-trader.config';
import { SignalTraderRepository } from './repositories/signal-trader.repository';
import { SignalJudgeService } from './services/signal-judge.service';
import { SignalContextService } from './services/signal-context.service';
import { SignalExecutorService } from './services/signal-executor.service';
import { SignalPaperService } from './services/signal-paper.service';
import { SignalPaperWatchService } from './services/signal-paper-watch.service';
import {
  SIGNAL_FUNDS,
  SIGNAL_INSTRUMENT_MASTER,
  SIGNAL_PAPER,
  SIGNAL_QUOTES,
  SIGNAL_SESSION_CLOCK,
  SIGNAL_TRADER_CONFIG,
  SIGNAL_TRADER_ENV,
  SignalTraderService,
  type FundsLike,
  type QuotesLike,
} from './services/signal-trader.service';
import { SignalTraderController } from './controllers/signal-trader.controller';

/**
 * Telegram signal trading — stream X (docs/superpowers/plans/2026-10-23-telegram-signals-contract.md).
 * Consumes `signal.ready` / `signal.update` (EventEmitter2) from signal-intake. SIGNAL_TRADING
 * defaults to shadow: no order is ever placed unless it is `live` AND LIVE_TRADING_ENABLED=true AND
 * the SL can be executed by the sentinel's price-trigger exit path.
 */
@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    CredentialDecryptorModule,
    CredentialVaultModule,
    TradeEngineModule,
    TradeTrackerModule,
    TradeSentinelModule,
    AiGatewayModule,
    MbmModule,
  ],
  controllers: [SignalTraderController],
  providers: [
    SignalTraderRepository,
    SignalJudgeService,
    SignalContextService,
    SignalExecutorService,
    SignalTraderService,
    SignalPaperService,
    SignalPaperWatchService,
    { provide: SIGNAL_PAPER, useExisting: SignalPaperService },
    {
      // The owner's RMS available cash — the same sanitized funds read trade-setup sizes with
      // (BrokerOverviewService, own-account session: never a second login over the live feed).
      provide: SIGNAL_FUNDS,
      useFactory: (overview: BrokerOverviewService): FundsLike => ({
        available: async (userId) => (await overview.getFunds(userId))?.availableCash ?? null,
      }),
      inject: [BrokerOverviewService],
    },
    // The owner's broker session, exactly as the sentinel executor borrows it (no second login).
    PerUserBrokerSessionFactory,
    OwnerBrokerSessionProvider,
    { provide: SIGNAL_TRADER_CONFIG, useFactory: () => parseSignalTraderConfig(process.env) },
    { provide: SIGNAL_TRADER_ENV, useValue: process.env },
    {
      provide: SIGNAL_SESSION_CLOCK,
      useFactory: (config: ConfigService) =>
        new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }),
      inject: [ConfigService],
    },
    { provide: SIGNAL_INSTRUMENT_MASTER, useExisting: AngelOneAdapterService },
    {
      provide: SIGNAL_QUOTES,
      useFactory: (feeds: UserFeedManager): QuotesLike => ({
        ltp: async (userId, token, exchange) => {
          const q = await feeds.fetchQuote(userId, token, exchange);
          return q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
        },
      }),
      inject: [UserFeedManager],
    },
  ],
})
export class SignalTraderModule {}
