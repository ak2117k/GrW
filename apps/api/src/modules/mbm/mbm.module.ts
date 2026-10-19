// apps/api/src/modules/mbm/mbm.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { SessionClock } from '../market-hub/session-clock';
import { MBM_CONFIG, parseMbmConfig } from './mbm.config';
import { MbmBarsRepository } from './repositories/mbm-bars.repository';
import { MBM_CALENDAR, MBM_NOW, MbmBarRefresherService } from './services/mbm-bar-refresher.service';
import { MBM_FETCH, MbmClient } from './services/mbm-client.service';
import { MbmController } from './controllers/mbm.controller';

/**
 * Market-behaviour model, M2 serving (docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §4):
 * the 1m bar refresher feeding mbm_bars_1m and a fail-open proxy to the MBM service.
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
    MbmClient,
  ],
  exports: [MbmClient, MBM_CONFIG],
})
export class MbmModule {}
