import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** How long the symbol set is reused before being rebuilt from the database. */
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Every listed base symbol, as a Set, for tagging news articles.
 *
 * Built from the `instruments` table — the same allowlist the rest of the
 * platform resolves symbols against — rather than a list maintained by hand.
 * The hardcoded list it replaces held 49 names; the table holds 18,949, and the
 * names actually being traded (KEI, MOTHERSON, HAL, BDL) were all in the table
 * and none of them in the list.
 *
 * Cached with a long TTL: listings change on the scale of days, and rebuilding
 * costs one query returning ~19k short strings. Loaded LAZILY on first use, so
 * this never adds to boot time.
 */
@Injectable()
export class NewsSymbolIndexService {
  private readonly logger = new Logger(NewsSymbolIndexService.name);
  private cache: { at: number; symbols: Set<string> } | null = null;
  private inFlight: Promise<Set<string>> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async symbols(): Promise<ReadonlySet<string>> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.symbols;
    // Single-flight: news is ingested in batches, so without this a cold cache
    // would fire one identical 19k-row query per article in the batch.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<Set<string>> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ s: string }>>(
        // Series suffix stripped in SQL so `KEI-EQ` and `KEI` collapse to one
        // key — the same normalisation the tagger's tokens will have.
        `SELECT DISTINCT upper(regexp_replace(symbol, '-[A-Z0-9]{1,3}$', '')) AS s
           FROM instruments
          WHERE exchange IN ('NSE','BSE') AND "isActive" = true`,
      );
      const symbols = new Set(rows.map((r) => r.s).filter(Boolean));
      this.cache = { at: Date.now(), symbols };
      this.logger.log(`News symbol index built: ${symbols.size} listed symbols`);
      return symbols;
    } catch (err) {
      // Serve the STALE set rather than none. An empty set silently tags every
      // article with nothing, which is indistinguishable from "no news mentions
      // your holdings" — the exact false-quiet this whole change removes.
      const message = err instanceof Error ? err.message : String(err);
      if (this.cache) {
        this.logger.warn(`News symbol index refresh failed, serving stale set: ${message}`);
        return this.cache.symbols;
      }
      this.logger.error(`News symbol index unavailable, articles will be untagged: ${message}`);
      return new Set();
    }
  }
}
