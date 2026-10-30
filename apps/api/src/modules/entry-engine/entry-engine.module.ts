import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AngelOneAdapterService } from '../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { parseSignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';
import { SignalOiCheckService } from '../signal-trader/services/signal-oi-check.service';
import type { QuotesLike } from '../signal-trader/services/signal-trader.service';
import { ENTRY_ENGINE_CONFIG, parseEntryEngineConfig } from './entry-engine.config';
import { EntryEnginePaperService } from './entry-engine-paper.service';
import { EntryEngineRepository } from './entry-engine.repository';
import { ENGINE_CLOCK, ENGINE_MASTER, ENGINE_QUOTES, ENGINE_SIGNAL_CONFIG, EntryEngineService } from './entry-engine.service';

/**
 * ENTRY ENGINE stage 1 (owner 2026-10-30): news + trend + OI → ENTER_CE / ENTER_PE / NO_TRADE, every
 * evaluation recorded in entry_engine_decisions. ENTRY_ENGINE=off|observe|paper (default observe:
 * records only). paper opens PAPER trades only (TradeExecutionService isPaper: true, strategy
 * ENGINE_ENTRY); the signal-trader paper watch and the paper sentinel then manage them like the
 * Telegram paper trades. SignalTraderRepository / SignalOiCheckService are provided here (Prisma only)
 * for the DB-only OI read, so signal-trader's module is untouched.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, TradeEngineModule],
  providers: [
    EntryEngineRepository,
    EntryEnginePaperService,
    EntryEngineService,
    SignalTraderRepository,
    SignalOiCheckService,
    { provide: ENTRY_ENGINE_CONFIG, useFactory: () => parseEntryEngineConfig(process.env) },
    { provide: ENGINE_SIGNAL_CONFIG, useFactory: () => parseSignalTraderConfig(process.env) },
    {
      provide: ENGINE_CLOCK,
      useFactory: (config: ConfigService) => new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }),
      inject: [ConfigService],
    },
    { provide: ENGINE_MASTER, useExisting: AngelOneAdapterService },
    {
      // A fresh LTP over the owner's own Angel feed session (a quote, never an order).
      provide: ENGINE_QUOTES,
      useFactory: (feeds: UserFeedManager): QuotesLike => ({
        ltp: async (userId, token, exchange) => {
          const q = await feeds.fetchQuote(userId, token, exchange);
          return q && Number.isFinite(q.ltp) && q.ltp > 0 ? q.ltp : null;
        },
      }),
      inject: [UserFeedManager],
    },
  ],
  exports: [EntryEngineService],
})
export class EntryEngineModule {}
