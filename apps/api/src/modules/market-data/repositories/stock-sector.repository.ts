import { Injectable, Logger } from '@nestjs/common';
import { StockSector } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * One stock → sector-index mapping row destined for the `stock_sectors`
 * table. `sectorIndexToken` is null when the NSE `Industry` string has no
 * clean NIFTY sectoral index — the row is still persisted so the lookup
 * has a definitive answer.
 */
export interface StockSectorRow {
  symbol: string;
  industry: string;
  sectorIndexToken: string | null;
}

/**
 * Data access for the broad stock → sector-index map. Owned by the
 * market-data module; written by NseSectorIndexService's daily refresh
 * and read on the scoring hot-path via getSectorIndexForSymbol.
 */
@Injectable()
export class StockSectorRepository {
  private readonly logger = new Logger(StockSectorRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Look up one row by bare trading symbol (case-insensitive). */
  async findBySymbol(symbol: string): Promise<StockSector | null> {
    return this.prisma.stockSector.findUnique({
      where: { symbol: symbol.toUpperCase() },
    });
  }

  /**
   * Upsert a batch of rows keyed by `symbol`. Each row is inserted or
   * updated (industry + token + updatedAt). Runs in batched transactions
   * so a NIFTY-500-sized payload stays a single DB round-trip per batch.
   * Returns the number of rows processed.
   */
  async upsertMany(rows: StockSectorRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    let count = 0;
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        await this.prisma.$transaction(
          batch.map((r) =>
            this.prisma.stockSector.upsert({
              where: { symbol: r.symbol.toUpperCase() },
              create: {
                symbol: r.symbol.toUpperCase(),
                industry: r.industry,
                sectorIndexToken: r.sectorIndexToken,
              },
              update: {
                industry: r.industry,
                sectorIndexToken: r.sectorIndexToken,
              },
            }),
          ),
        );
        count += batch.length;
      } catch (err) {
        this.logger.error(
          `StockSector upsert batch at offset ${i} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
        // Continue with remaining batches — partial coverage beats none.
      }
    }
    return count;
  }

  /** Total rows currently in the table. For ops/stats endpoints. */
  async count(): Promise<number> {
    return this.prisma.stockSector.count();
  }
}
