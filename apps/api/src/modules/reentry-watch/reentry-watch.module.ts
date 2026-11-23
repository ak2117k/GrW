import { Module } from '@nestjs/common';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { sendOpsAlert } from '../../common/utils/ops-alert';
import { EntryEnginePaperService } from '../entry-engine/entry-engine-paper.service';
import { EntryEngineRepository } from '../entry-engine/entry-engine.repository';
import { MarketDataModule } from '../market-data/market-data.module';
import { AngelOneAdapterService } from '../market-data/services/angel-one-adapter.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';
import { SignalOiCheckService } from '../signal-trader/services/signal-oi-check.service';
import type { QuotesLike } from '../signal-trader/services/signal-trader.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { CredentialVaultModule } from '../credential-vault/credential-vault.module';
import { BrokerOverviewService } from '../credential-vault/services/broker-overview.service';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { OwnerBrokerSessionProvider } from '../sentinel-executor/services/owner-broker-session.provider';
import { usableFunds } from '../signal-trader/domain/funds';
import { SignalExecutorService } from '../signal-trader/services/signal-executor.service';
import type { FundsLike } from '../signal-trader/services/signal-trader.service';
import { parseReentryWatchConfig, REENTRY_WATCH_CONFIG } from './reentry-watch.config';
import { ReentryWatchRepository } from './reentry-watch.repository';
import { REENTRY_ALERT, REENTRY_CLOCK, REENTRY_ENV, REENTRY_FUNDS, REENTRY_MASTER, REENTRY_QUOTES, REENTRY_SIGNAL_CONFIG, ReentryWatchService, type ReentryClockLike } from './reentry-watch.service';

/**
 * RE-ENTRY WATCH (owner 2026-11-05): after an option position is exited, watch its underlying for a SAME /
 * OPPOSITE direction re-entry; REENTRY_WATCH=paper|off|live (default paper). In paper mode trades open through the
 * entry engine's EntryEnginePaperService (TradeExecutionService isPaper: true, strategy REENTRY_WATCH). The
 * entry engine's repository / paper service and signal-trader's DB-only OI read are provided here (stateless,
 * Prisma / trade-engine only), so neither module is changed to export them.
 *
 * LIVE mode (REENTRY_WATCH=live, 2026-11-23): the signal trader's live entry path is provided here the same way
 * (SignalExecutorService + the owner's BORROWED broker session, OwnerBrokerSessionProvider — never a second login —
 * + the funds read), mirroring SignalTraderModule's providers, so SignalTraderModule is not changed to export them
 * and no module imports the other (no circular import). These are stateless: the claim-first signal_orders row is
 * the only at-most-once guard and it lives in the DB.
 */
@Module({
  // TradeSentinelModule: the AI entry judge (EntryJudgeService).
  imports: [PrismaModule, MarketDataModule, TradeEngineModule, TradeSentinelModule, TradeTrackerModule, CredentialDecryptorModule, CredentialVaultModule],
  providers: [
    ReentryWatchRepository,
    ReentryWatchService,
    EntryEngineRepository,
    EntryEnginePaperService,
    SignalTraderRepository,
    SignalOiCheckService,
    // LIVE mode: the signal trader's entry executor and the owner's borrowed broker session (no second login).
    PerUserBrokerSessionFactory,
    OwnerBrokerSessionProvider,
    SignalExecutorService,
    {
      // The owner's usable RMS margin, read exactly as the signal trader reads it (BrokerOverviewService).
      provide: REENTRY_FUNDS,
      useFactory: (overview: BrokerOverviewService): FundsLike => ({ available: async (userId) => usableFunds(await overview.getFunds(userId)) }),
      inject: [BrokerOverviewService],
    },
    { provide: REENTRY_ENV, useValue: process.env },
    { provide: REENTRY_WATCH_CONFIG, useFactory: () => parseReentryWatchConfig(process.env) },
    { provide: REENTRY_SIGNAL_CONFIG, useFactory: () => parseSignalTraderConfig(process.env) },
    { provide: REENTRY_ALERT, useValue: (key: string, text: string) => sendOpsAlert(key, text) },
    {
      provide: REENTRY_CLOCK,
      // now(): the live gate reads the current instant at decision time, not the run's start (review fix 2026-11-23).
      useFactory: (config: ConfigService): ReentryClockLike =>
        Object.assign(new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }), { now: () => new Date() }),
      inject: [ConfigService],
    },
    { provide: REENTRY_MASTER, useExisting: AngelOneAdapterService },
    {
      // A fresh LTP over the owner's own Angel feed session (a quote, never an order).
      provide: REENTRY_QUOTES,
      useFactory: (feeds: UserFeedManager): QuotesLike => ({
        ltp: async (userId, token, exchange) => {
          const q = await feeds.fetchQuote(userId, token, exchange);
          return q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
        },
      }),
      inject: [UserFeedManager],
    },
  ],
  exports: [ReentryWatchService],
})
export class ReentryWatchModule {}
