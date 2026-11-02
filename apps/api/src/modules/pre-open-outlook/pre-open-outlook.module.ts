import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { EntryEngineRepository } from '../entry-engine/entry-engine.repository';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { MarketCuesModule } from '../market-cues/market-cues.module';
import { SessionClock } from '../market-hub/session-clock';
import { PreOpenOutlookController } from './controllers/pre-open-outlook.controller';
import { PRE_OPEN_OUTLOOK_REPORT } from './pre-open-outlook.ports';
import { PreOpenOutlookRepository } from './pre-open-outlook.repository';
import { GlobalPriceService } from './services/global-price.service';
import { OffHoursNewsService } from './services/off-hours-news.service';
import { PRE_OPEN_CLOCK, PreOpenOutlookService } from './services/pre-open-outlook.service';

/**
 * PRE-OPEN OUTLOOK (owner 2026-11-02): global prices (Yahoo chart, every 30 min incl. weekends →
 * global_price_snapshots), the 08:30 IST outlook per underlying (→ pre_open_outlooks, ops alert,
 * the night report section, the entry engine's PRE_OPEN news path) and the off-hours news fetch
 * (enqueues the existing 'news-fetch' job when the news module's own schedule does not run).
 * Reads and HTTP GETs only, plus its two tables; places nothing, reaches no broker.
 * `@Global` so the night report injects PRE_OPEN_OUTLOOK_REPORT @Optional.
 * Switches: PRE_OPEN_OUTLOOK=off, GLOBAL_PRICES=off, NEWS_OFFHOURS_FETCH=off, BOOT_JOBS=false.
 */
@Global()
@Module({
  imports: [PrismaModule, MarketCuesModule, BullModule.registerQueue({ name: 'news-fetch' })],
  controllers: [PreOpenOutlookController],
  providers: [
    PreOpenOutlookRepository,
    // The entry engine's read-only impacts query (stateless, Prisma only); its module is untouched.
    EntryEngineRepository,
    GlobalPriceService,
    { provide: PRE_OPEN_CLOCK, useFactory: () => new SessionClock({ holidays: MARKET_HOLIDAYS }) },
    PreOpenOutlookService,
    { provide: PRE_OPEN_OUTLOOK_REPORT, useExisting: PreOpenOutlookService },
    OffHoursNewsService,
  ],
  exports: [PRE_OPEN_OUTLOOK_REPORT],
})
export class PreOpenOutlookModule {}
