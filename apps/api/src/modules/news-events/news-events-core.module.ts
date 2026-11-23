import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NEWS_EVENTS_CONFIG, newsEventsBootLine, parseNewsEventsConfig, type NewsEventsConfig } from './config';
import { InProcessNewsIngestBus, NEWS_INGEST_BUS } from './ingest-bus';
import { NseClient } from './nse-client';
import { SectorMapService } from './sector-map.service';
import { SourceHealthBook } from './source-health';
import { parseNewsFilterMode } from './filter/news-relevance';
import { NewsRelevanceService } from './filter/news-relevance.service';

const logger = new Logger('NewsEvents');

/**
 * News & events v2 shared singletons: the parsed config, the ingest bus, the
 * source-health book, the ONE polite NseClient and the in-memory SectorMapService. Imported by
 * NewsModule, NewsIndexModule, MarketEventsModule and TradeSentinelModule — Nest
 * keeps ONE instance of each provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: NEWS_EVENTS_CONFIG, useFactory: () => parseNewsEventsConfig(process.env) },
    {
      provide: NEWS_INGEST_BUS,
      useFactory: () => new InProcessNewsIngestBus((e) => logger.error(`[news-events] bus subscriber threw: ${String(e)}`)),
    },
    { provide: SourceHealthBook, useFactory: () => new SourceHealthBook((line) => logger.log(line)) },
    { provide: NseClient, useFactory: () => new NseClient({ log: (line) => logger.warn(line) }) },
    SectorMapService,
    NewsRelevanceService,
  ],
  exports: [NEWS_EVENTS_CONFIG, NEWS_INGEST_BUS, SourceHealthBook, NseClient, SectorMapService, NewsRelevanceService],
})
export class NewsEventsCoreModule implements OnModuleInit {
  constructor(@Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig) {}

  onModuleInit(): void {
    logger.log(newsEventsBootLine(this.cfg));
    for (const p of this.cfg.problems) logger.warn(`[news-events] ${p}`);
    logger.log(`[news-filter] NEWS_FILTER=${parseNewsFilterMode(process.env)} (off | observe = record the would-be reason | on = hide filtered rows)`);
  }
}
