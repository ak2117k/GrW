import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from './config';
import { baseSymbol, SECTOR_TOKEN_NAME } from './keys';
import type { SectorLookup } from './types';

export function buildSectorMap(rows: Array<{ symbol: string; sectorIndexToken: string | null }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const name = r.sectorIndexToken ? SECTOR_TOKEN_NAME[r.sectorIndexToken] : undefined;
    if (name) m.set(baseSymbol(r.symbol), name);
  }
  return m;
}

/**
 * Symbol → NSE sectoral index name, in memory, for tagging (§5.4) and the ladder (§7).
 * Built from `stock_sectors` (NseSectorIndexService refreshes it at 06:00 IST); reloaded
 * at 06:30 IST. `sectorOf` is synchronous. A failed reload keeps the previous map.
 */
@Injectable()
export class SectorMapService implements SectorLookup, OnModuleInit {
  private readonly logger = new Logger(SectorMapService.name);
  private map = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
  ) {}

  get ready(): boolean {
    return this.loaded;
  }

  onModuleInit(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    void this.refresh();
  }

  @Cron('0 30 6 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (this.cfg.computing) await this.refresh();
  }

  async refresh(): Promise<number> {
    try {
      const rows = await this.prisma.stockSector.findMany({ select: { symbol: true, sectorIndexToken: true } });
      this.map = buildSectorMap(rows);
      this.loaded = true;
      this.logger.log(`[news-tag] sector map: ${this.map.size} symbols`);
      return this.map.size;
    } catch (err) {
      this.logger.warn(`[news-tag] sector map reload failed, keeping ${this.map.size} symbols: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  sectorOf(symbol: string): string | null {
    return this.map.get(baseSymbol(symbol)) ?? null;
  }
}
