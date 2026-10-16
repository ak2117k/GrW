import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NseClient } from '../nse-client';
import { deriveAliases, parseEquityL, type AliasRow } from './alias-derivation';
import { NewsTaggerService } from './tagger.service';

export const EQUITY_L_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

/**
 * EQUITY_L.csv → instrument_name_aliases → the tagger's matcher (spec §5.2). Boot loads
 * the table (no network unless it is empty); 08:05 IST Mon–Fri refreshes from NSE.
 * A failed refresh leaves the table and the matcher exactly as they were.
 */
@Injectable()
export class AliasLoaderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AliasLoaderService.name);

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    void this.loadFromDb()
      .then((n) => (n === 0 ? this.refresh() : n))
      .catch((err) => this.logger.warn(`[news-tag] alias boot load failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  @Cron('0 5 8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (!this.cfg.computing) return;
    try {
      await this.refresh();
    } catch (err) {
      this.logger.warn(`[news-tag] alias refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async loadFromDb(): Promise<number> {
    const rows = (await this.prisma.instrumentNameAlias.findMany({ select: { symbol: true, alias: true, kind: true } })) as AliasRow[];
    if (rows.length > 0) this.tagger.rebuild(rows);
    return rows.length;
  }

  async refresh(): Promise<number> {
    let rows: AliasRow[];
    try {
      const listed = parseEquityL(await this.nse.getText('NSE EQUITY_L', EQUITY_L_URL));
      // A header-only or truncated body must not wipe the table down to the curated forms.
      if (listed.length === 0) throw new Error('EQUITY_L had no company rows');
      rows = deriveAliases(listed);
    } catch (err) {
      this.logger.warn(`[news-tag] alias refresh failed, keeping the stored aliases: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.instrumentNameAlias.deleteMany({ where: { source: { in: ['EQUITY_L', 'curated'] } } });
      await tx.instrumentNameAlias.createMany({
        data: rows.map((r) => ({ ...r, source: r.kind === 'curated' ? 'curated' : 'EQUITY_L', updatedAt: now })),
        skipDuplicates: true,
      });
    });
    this.tagger.rebuild(rows);
    this.logger.log(`[news-tag] aliases refreshed from EQUITY_L: ${rows.length}`);
    return rows.length;
  }
}
