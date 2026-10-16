import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NEWS_EVENTS_CONFIG, newsEventsBootLine, parseNewsEventsConfig, type NewsEventsConfig } from './config';
import { InProcessNewsIngestBus, NEWS_INGEST_BUS } from './ingest-bus';
import { NseClient } from './nse-client';
import { SectorMapService } from './sector-map.service';
import { SourceHealthBook } from './source-health';

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
  ],
  exports: [NEWS_EVENTS_CONFIG, NEWS_INGEST_BUS, SourceHealthBook, NseClient, SectorMapService],
})
export class NewsEventsCoreModule implements OnModuleInit {
  constructor(@Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig) {}

  onModuleInit(): void {
    logger.log(newsEventsBootLine(this.cfg));
    for (const p of this.cfg.problems) logger.warn(`[news-events] ${p}`);
  }
}
