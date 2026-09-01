import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface SaveCandleInput {
  instrumentId: string;
  timeframe: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SaveOISnapshotInput {
  instrumentId: string;
  oi: number;
  oiChange: number;
  volume: number;
  timestamp: Date;
}

export interface UpsertInstrumentInput {
  symbol: string;
  token: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize?: number;
  tickSize?: number;
  expiry?: Date;
  strike?: number;
  optionType?: string;
}

@Injectable()
export class MarketDataRepository {
  private readonly logger = new Logger(MarketDataRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bulk insert candles using createMany with skipDuplicates to handle
   * the unique constraint on (instrumentId, timeframe, timestamp).
   */
  async saveCandles(candles: SaveCandleInput[]): Promise<number> {
    if (candles.length === 0) return 0;

    try {
      const result = await this.prisma.candle.createMany({
        data: candles.map((c) => ({
          instrumentId: c.instrumentId,
          timeframe: c.timeframe,
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: BigInt(Math.round(c.volume)),
        })),
        skipDuplicates: true,
      });

      this.logger.debug(`Saved ${result.count} candles`);
      return result.count;
    } catch (error) {
      this.logger.error(
        `Failed to save candles: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Upsert a single candle row keyed by the unique
   * (instrumentId, timeframe, timestamp) constraint. Used when we need
   * to overwrite a previously-stored row with revised broker values
   * (e.g. Angel One's daily candles get late-print adjustments
   * post-market-close, and the original row in DB is stale). saveCandles
   * uses createMany + skipDuplicates which can't update existing rows;
   * this is its surgical complement.
   */
  async upsertCandle(input: SaveCandleInput): Promise<{ created: boolean }> {
    const existing = await this.prisma.candle.findUnique({
      where: {
        instrumentId_timeframe_timestamp: {
          instrumentId: input.instrumentId,
          timeframe: input.timeframe,
          timestamp: input.timestamp,
        },
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.candle.update({
        where: { id: existing.id },
        data: {
          open: input.open,
          high: input.high,
          low: input.low,
          close: input.close,
          volume: BigInt(Math.round(input.volume)),
        },
      });
      return { created: false };
    }
    await this.prisma.candle.create({
      data: {
        instrumentId: input.instrumentId,
        timeframe: input.timeframe,
        timestamp: input.timestamp,
        open: input.open,
        high: input.high,
        low: input.low,
        close: input.close,
        volume: BigInt(Math.round(input.volume)),
      },
    });
    return { created: true };
  }

  /**
   * Repoint an instrument row to a new token. Used by InstrumentService
   * to fix stale FUTCOM contract tokens after a monthly roll.
   */
  async updateInstrumentToken(id: string, token: string): Promise<void> {
    await this.prisma.instrument.update({
      where: { id },
      data: { token },
    });
  }

  /**
   * Most-recent candle for `(instrumentId, timeframe)` strictly before `before`.
   * Used by LevelBookService to detect when a newer daily candle has landed
   * since the in-memory book was seeded — so a live-fed book doesn't keep
   * serving stale PDH/PDL after the previous-day candle finally arrives.
   */
  async getLatestCandleBefore(
    instrumentId: string,
    timeframe: string,
    before: Date,
  ): Promise<{ timestamp: Date } | null> {
    return this.prisma.candle.findFirst({
      where: { instrumentId, timeframe, timestamp: { lt: before } },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
  }

  /**
   * Query candles for a given instrument, timeframe, and date range.
   */
  async getCandles(
    instrumentId: string,
    timeframe: string,
    from: Date,
    to: Date,
    take?: number,
  ) {
    // When `take` is provided, fetch the most-recent N rows in DESC order and
    // reverse so the caller still gets ascending timestamps. This is the fast
    // path for indicator computation: we only need the last ~200 bars even
    // when the [from, to] window contains 200k+ rows (e.g. 90 days of 1m
    // commodity bars). Without the cap a single scan-now would burn 3 minutes
    // serializing rows the strategy never reads.
    if (take !== undefined) {
      const rows = await this.prisma.candle.findMany({
        where: {
          instrumentId,
          timeframe,
          timestamp: { gte: from, lte: to },
        },
        orderBy: { timestamp: 'desc' },
        take,
      });
      return rows.reverse();
    }
    return this.prisma.candle.findMany({
      where: {
        instrumentId,
        timeframe,
        timestamp: {
          gte: from,
          lte: to,
        },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  /**
   * Save a single OI snapshot data point.
   */
  async saveOISnapshot(snapshot: SaveOISnapshotInput): Promise<void> {
    try {
      await this.prisma.oISnapshot.create({
        data: {
          instrumentId: snapshot.instrumentId,
          oi: BigInt(snapshot.oi),
          oiChange: BigInt(snapshot.oiChange),
          volume: BigInt(snapshot.volume),
          timestamp: snapshot.timestamp,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to save OI snapshot: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Query OI history for a given instrument and date range.
   */
  async getOIHistory(instrumentId: string, from: Date, to: Date) {
    return this.prisma.oISnapshot.findMany({
      where: {
        instrumentId,
        timestamp: {
          gte: from,
          lte: to,
        },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  /**
   * Create or update an instrument record.
   * Uses the unique constraint on (symbol, exchange, token).
   */
  async upsertInstrument(data: UpsertInstrumentInput) {
    return this.prisma.instrument.upsert({
      where: {
        symbol_exchange_token: {
          symbol: data.symbol,
          exchange: data.exchange,
          token: data.token,
        },
      },
      update: {
        name: data.name,
        segment: data.segment,
        lotSize: data.lotSize ?? 1,
        tickSize: data.tickSize ?? 0.05,
        expiry: data.expiry ?? null,
        strike: data.strike ?? null,
        optionType: data.optionType ?? null,
        isActive: true,
      },
      create: {
        symbol: data.symbol,
        token: data.token,
        name: data.name,
        exchange: data.exchange,
        segment: data.segment,
        lotSize: data.lotSize ?? 1,
        tickSize: data.tickSize ?? 0.05,
        expiry: data.expiry ?? null,
        strike: data.strike ?? null,
        optionType: data.optionType ?? null,
      },
    });
  }

  /**
   * Search instruments by symbol/name with optional exchange and segment filters.
   * Uses case-insensitive matching.
   */
  async searchInstruments(
    query: string,
    exchange?: string,
    segment?: string,
  ) {
    const where: any = {
      isActive: true,
      OR: [
        { symbol: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
      ],
    };

    if (exchange) {
      where.exchange = exchange;
    }
    if (segment) {
      where.segment = segment;
    }

    return this.prisma.instrument.findMany({
      where,
      take: 50,
      orderBy: { symbol: 'asc' },
    });
  }

  /**
   * Get a single instrument by its token.
   */
  async getInstrumentByToken(token: string) {
    return this.prisma.instrument.findFirst({
      where: { token, isActive: true },
    });
  }

  /**
   * Find an instrument by trading symbol + exchange. Used by
   * Chartink integration to resolve scanner-emitted symbols to
   * tokens. Returns null when no instrument matches.
   */
  async getInstrumentBySymbol(symbol: string, exchange: string) {
    return this.prisma.instrument.findFirst({
      where: { symbol, exchange },
    });
  }

  /**
   * Load every active instrument in the DB. Used by InstrumentService at
   * boot to prime the in-memory token→instrumentId cache so the candle
   * aggregator has mappings for all tradable segments (NSE indices, NFO
   * options, and MCX commodities) without per-token DB round-trips on
   * every incoming tick.
   *
   * NOTE: returns the full instrument row set, not paginated — intended
   * for cold-start cache warmup, not request-path use.
   */
  async getAllActiveInstruments() {
    return this.prisma.instrument.findMany({
      where: { isActive: true },
      orderBy: { symbol: 'asc' },
    });
  }

  /**
   * ONE BOUNDED PAGE of active instruments, for the in-memory cache warm.
   *
   * `getAllActiveInstruments` above returns the whole table in a single result
   * set. That was fine while `instruments` held a few thousand cash equities.
   * It stopped being fine when the master refresh began storing every live
   * derivative contract — each strike of each unexpired NFO/MCX/BFO/CDS expiry
   * — because the row count grew by orders of magnitude and the client, the
   * driver and the database all hold that result at once. On a free-tier
   * compute that exhausts memory, and the cache warm runs at boot, so the
   * failure repeats on every restart.
   *
   * Three deliberate choices:
   *
   * - `select` rather than the whole row: `createdAt`/`updatedAt`/`isActive` are
   *   never read by the cache, and at this row count they are not free.
   * - `orderBy: id` rather than `symbol`: the walk needs a stable total order,
   *   and the primary key gives one from an index the table already has. Order
   *   is meaningless to the caller either way — it builds hash maps.
   * - keyset paging via `cursor`, not `skip`/`offset`: an offset walk re-reads
   *   and discards every earlier row, so the last page costs the most. A cursor
   *   resumes at the id and each page costs the same.
   */
  async getActiveInstrumentPage(take: number, cursorId?: string) {
    return this.prisma.instrument.findMany({
      where: { isActive: true },
      select: {
        id: true,
        symbol: true,
        token: true,
        name: true,
        exchange: true,
        segment: true,
        lotSize: true,
        tickSize: true,
        expiry: true,
        strike: true,
        optionType: true,
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  }

  /**
   * Get instruments by a list of tokens.
   */
  async getInstrumentsByTokens(tokens: string[]) {
    return this.prisma.instrument.findMany({
      where: { token: { in: tokens }, isActive: true },
    });
  }

  /**
   * When the instrument master was last written, or null for an empty table.
   *
   * DB-backed on purpose. `InstrumentService.lastRefreshedAt` is an in-memory
   * field and therefore resets to undefined on every process start — which is
   * exactly the moment the boot refresh needs to ask the question. Reading it
   * there would answer "never refreshed" after every restart and defeat the
   * whole circuit breaker.
   */
  async lastInstrumentUpdateAt(): Promise<Date | null> {
    const row = await this.prisma.instrument.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    return row?.updatedAt ?? null;
  }

  /**
   * Bulk upsert instruments (used during master refresh).
   * Processes in batches to avoid overwhelming the database.
   */
  /**
   * Upsert the instrument master.
   *
   * BATCH SIZE IS A CONNECTION-POOL DECISION, not a throughput one. At 100 it
   * fired 100 concurrent writes per batch; against a serverless Postgres pooler
   * and a master that now carries derivative contracts, that saturated the pool
   * for the length of the refresh — and the casualty was elsewhere in boot,
   * where the Angel One auto-login died with "Transaction already closed: the
   * timeout for this transaction was 5000 ms, however 8478 ms passed". A refresh
   * that starves the rest of the application is slower overall than one that
   * takes longer and leaves room.
   */
  async bulkUpsertInstruments(instruments: UpsertInstrumentInput[]): Promise<number> {
    let count = 0;
    const batchSize = 25;

    for (let i = 0; i < instruments.length; i += batchSize) {
      const batch = instruments.slice(i, i + batchSize);
      const promises = batch.map((inst) => this.upsertInstrument(inst));

      try {
        await Promise.all(promises);
        count += batch.length;
      } catch (error) {
        this.logger.error(
          `Failed upserting instrument batch at offset ${i}: ${error instanceof Error ? error.message : error}`,
        );
        // Continue with remaining batches
      }
    }

    return count;
  }
}
