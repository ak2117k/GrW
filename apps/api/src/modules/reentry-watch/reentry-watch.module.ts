import { Module } from '@nestjs/common';
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
import { parseReentryWatchConfig, REENTRY_WATCH_CONFIG } from './reentry-watch.config';
import { ReentryWatchRepository } from './reentry-watch.repository';
import { REENTRY_ALERT, REENTRY_CLOCK, REENTRY_MASTER, REENTRY_QUOTES, REENTRY_SIGNAL_CONFIG, ReentryWatchService } from './reentry-watch.service';

/**
 * RE-ENTRY WATCH (owner 2026-11-05): after an option position is exited, watch its underlying for a SAME /
 * OPPOSITE direction re-entry; REENTRY_WATCH=paper|off (default paper). PAPER only — trades open through the
 * entry engine's EntryEnginePaperService (TradeExecutionService isPaper: true, strategy REENTRY_WATCH). The
 * entry engine's repository / paper service and signal-trader's DB-only OI read are provided here (stateless,
 * Prisma / trade-engine only), so neither module is changed to export them.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, TradeEngineModule],
  providers: [
    ReentryWatchRepository,
    ReentryWatchService,
    EntryEngineRepository,
    EntryEnginePaperService,
    SignalTraderRepository,
    SignalOiCheckService,
    { provide: REENTRY_WATCH_CONFIG, useFactory: () => parseReentryWatchConfig(process.env) },
    { provide: REENTRY_SIGNAL_CONFIG, useFactory: () => parseSignalTraderConfig(process.env) },
    { provide: REENTRY_ALERT, useValue: (key: string, text: string) => sendOpsAlert(key, text) },
    {
      provide: REENTRY_CLOCK,
      useFactory: (config: ConfigService) => new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }),
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
