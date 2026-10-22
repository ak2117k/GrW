// apps/api/src/modules/mbm/mbm.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { SessionClock } from '../market-hub/session-clock';
import { MBM_CONFIG, parseMbmConfig } from './mbm.config';
import { MbmBarsRepository } from './repositories/mbm-bars.repository';
import { MbmChainRepository } from './repositories/mbm-chain.repository';
import { MbmCaptureLane } from './services/mbm-capture-lane';
import { MbmChainCaptureService } from './services/mbm-chain-capture.service';
import { MBM_CALENDAR, MBM_NOW, MbmBarRefresherService } from './services/mbm-bar-refresher.service';
import { MBM_FETCH, MbmClient } from './services/mbm-client.service';
import { MbmController } from './controllers/mbm.controller';
import { CHAIN_WATCHLIST, ChainWatchlistService } from './chain-watchlist';
import { MbmChainReader } from './services/mbm-chain-reader.service';
import { MbmStockChainCaptureService } from './services/mbm-stock-chain-capture.service';
import { parseOiHistoryConfig } from './domain/oi-history';
import { OiHistoryRepository } from './repositories/oi-history.repository';
import { OI_HISTORY_CONFIG, OiHistoryBackfillService } from './services/oi-history-backfill.service';

/**
 * Market-behaviour model, M2 serving (docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §4):
 * the 1m bar refresher feeding mbm_bars_1m and a fail-open proxy to the MBM service, plus the NIFTY
 * option-chain capture into mbm_chain_snapshots (MBM_CHAIN_CAPTURE, independent of MBM_ENABLED), and
 * the per-symbol capture of the chain watchlist (MBM_CHAIN_CAPTURE_STOCKS) with its read helpers, and the
 * nightly backfill of past intraday NIFTY OI from Angel getOIData into nifty_oi_history (OI_BACKFILL_ENABLED).
 * Inert while MBM_ENABLED=off (the default). Observe only — nothing trades on it.
 */
@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [MbmController],
  providers: [
    { provide: MBM_CONFIG, useFactory: () => parseMbmConfig(process.env) },
    { provide: MBM_CALENDAR, useFactory: () => new SessionClock({ holidays: MARKET_HOLIDAYS }) },
    { provide: MBM_NOW, useValue: () => new Date() },
    { provide: MBM_FETCH, useValue: (url: string, init: { signal: AbortSignal }) => fetch(url, init) },
    MbmBarsRepository,
    MbmBarRefresherService,
    MbmChainRepository,
    MbmCaptureLane,
    MbmChainCaptureService,
    ChainWatchlistService,
    { provide: CHAIN_WATCHLIST, useExisting: ChainWatchlistService },
    MbmStockChainCaptureService,
    MbmChainReader,
    MbmClient,
    { provide: OI_HISTORY_CONFIG, useFactory: () => parseOiHistoryConfig(process.env) },
    OiHistoryRepository,
    OiHistoryBackfillService,
  ],
  exports: [MbmClient, MBM_CONFIG, ChainWatchlistService, CHAIN_WATCHLIST, MbmChainReader, MbmStockChainCaptureService],
})
export class MbmModule {}
