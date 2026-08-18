import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MarketDataRepository,
  UpsertInstrumentInput,
} from '../repositories/market-data.repository';
import { CandleAggregatorService } from './candle-aggregator.service';
import { INDICES } from '@td/shared/constants';

export interface InstrumentRecord {
  id: string;
  symbol: string;
  token: string;
  name: string;
  exchange: string;
  segment: string;
  lotSize: number;
  tickSize: number;
  expiry: Date | null;
  strike: number | null;
  optionType: string | null;
}

@Injectable()
export class InstrumentService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentService.name);

  /** In-memory cache keyed by token for O(1) lookups. */
  private instrumentsByToken = new Map<string, InstrumentRecord>();

  /** Secondary index keyed by `${exchange}:${token}`. A numeric token is reused
   *  across segments (e.g. token 509 = NSE MAZDOCK-EQ AND MCX SSUGARMKOLCOM), so
   *  a token-alone lookup returns whichever instrument loaded last — which
   *  mislabels quotes (MAZDOCK showing as SSUGARMKOLCOM). This index resolves to
   *  the correct instrument per exchange. */
  private instrumentsByExchangeToken = new Map<string, InstrumentRecord>();

  /** Resolve by (exchange, token) — disambiguates cross-segment token
   *  collisions. Sync, cache-only; returns null if not loaded. */
  getByExchangeTokenSync(exchange: string, token: string): InstrumentRecord | null {
    return this.instrumentsByExchangeToken.get(`${exchange}:${token}`) ?? null;
  }

  /** Track when the master was last loaded. */
  private lastRefreshedAt: Date | null = null;

  constructor(
    private readonly repository: MarketDataRepository,
    private readonly configService: ConfigService,
    private readonly candleAggregator: CandleAggregatorService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.loadFromDatabase();
      this.logger.log(
        `Instrument cache initialized with ${this.instrumentsByToken.size} instruments`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize instrument cache: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Search instruments by symbol/name with optional exchange and segment filters.
   */
  async search(
    query: string,
    exchange?: string,
    segment?: string,
  ): Promise<InstrumentRecord[]> {
    // First try in-memory for speed
    const results: InstrumentRecord[] = [];
    const lowerQuery = query.toLowerCase();

    for (const inst of this.instrumentsByToken.values()) {
      if (
        (inst.symbol.toLowerCase().includes(lowerQuery) ||
          inst.name.toLowerCase().includes(lowerQuery)) &&
        (!exchange || inst.exchange === exchange) &&
        (!segment || inst.segment === segment)
      ) {
        results.push(inst);
        if (results.length >= 50) break;
      }
    }

    // Fall back to DB if in-memory cache is empty
    if (this.instrumentsByToken.size === 0) {
      const dbResults = await this.repository.searchInstruments(
        query,
        exchange,
        segment,
      );
      return dbResults as InstrumentRecord[];
    }

    return results;
  }

  /**
   * Fast O(1) lookup by token from the in-memory cache.
   * Falls back to DB if not found in cache.
   */
  async getByToken(token: string): Promise<InstrumentRecord | null> {
    const cached = this.instrumentsByToken.get(token);
    if (cached) return cached;

    // Try DB as fallback
    const dbInstrument = await this.repository.getInstrumentByToken(token);
    if (dbInstrument) {
      const record = dbInstrument as InstrumentRecord;
      this.instrumentsByToken.set(token, record);
      return record;
    }

    return null;
  }

  /**
   * Repoint an instrument row to a new token. Used to fix stale FUTCOM
   * contract tokens after a monthly roll without losing the instrument's
   * id (and thus its tied candle history). Also rewires the in-memory
   * caches so subsequent getByToken reads return the correct record.
   *
   * Usage: instrument.id is stable; only the `token` field changes.
   * Existing candles keyed by instrumentId remain accessible (though
   * those rows reflect the OLD contract's price action, so a fresh
   * backfill on the NEW token usually follows this call).
   */
  async updateTokenById(instrumentId: string, newToken: string): Promise<void> {
    // Find the current record so we can purge the stale-token entry
    // from the cache after the DB update.
    let stale: InstrumentRecord | null = null;
    for (const inst of this.instrumentsByToken.values()) {
      if (inst.id === instrumentId) {
        stale = inst;
        break;
      }
    }
    await this.repository.updateInstrumentToken(instrumentId, newToken);
    if (stale) {
      this.instrumentsByToken.delete(stale.token);
      const updated = { ...stale, token: newToken } as InstrumentRecord;
      this.instrumentsByToken.set(newToken, updated);
    }
    this.logger.log(
      `updateTokenById: instrument ${instrumentId} repointed${stale ? ` from ${stale.token}` : ''} to ${newToken}`,
    );
  }

  /**
   * Return tokens from the in-memory cache filtered by exchange and segment.
   * Used by MarketFeedService at boot to seed WebSocket subscriptions for
   * symbol classes whose tokens roll over time (e.g. MCX FUTCOM contracts) —
   * the DB is the source of truth, the constants file is not.
   */
  getTokensByExchangeSegment(exchange: string, segment: string): string[] {
    const tokens: string[] = [];
    for (const inst of this.instrumentsByToken.values()) {
      if (inst.exchange === exchange && inst.segment === segment) {
        tokens.push(inst.token);
      }
    }
    return tokens;
  }

  /**
   * MCX commodity instruments from the cache. Used by MarketFeedService
   * to sync the in-process COMMODITIES constants with whatever the DB
   * currently says — the broker adapter's exchange-routing logic keys
   * off those constants.
   */
  getCommodityInstruments(): Array<{ symbol: string; token: string }> {
    const out: Array<{ symbol: string; token: string }> = [];
    for (const inst of this.instrumentsByToken.values()) {
      if (inst.exchange === 'MCX' && inst.segment === 'COMMODITY') {
        out.push({ symbol: inst.symbol, token: inst.token });
      }
    }
    return out;
  }

  /**
   * Get major market indices (NIFTY 50, BANK NIFTY, etc.) with their instrument data.
   */
  getIndices(): Array<{
    key: string;
    symbol: string;
    token: string;
    exchange: string;
    instrument: InstrumentRecord | null;
  }> {
    return Object.entries(INDICES).map(([key, indexDef]) => ({
      key,
      symbol: indexDef.symbol,
      token: indexDef.token,
      exchange: indexDef.exchange,
      instrument: this.instrumentsByToken.get(indexDef.token) ?? null,
    }));
  }

  /**
   * Refresh instrument master list from Angel One API.
   * This is called daily by the housekeeping cron job.
   * The actual API call is delegated to the broker adapter;
   * if unavailable, the existing DB data is preserved.
   */
  /**
   * When the master was last written, read from the DATABASE rather than from
   * `this.lastRefreshedAt` — that field is in-memory and resets on every process
   * start, which is precisely when the boot refresh asks. See
   * `MarketDataRepository.lastInstrumentUpdateAt`.
   */
  async lastMasterRefreshAt(): Promise<Date | null> {
    return this.repository.lastInstrumentUpdateAt();
  }

  async refreshMaster(rawInstruments?: UpsertInstrumentInput[]): Promise<number> {
    this.logger.log('Starting instrument master refresh');

    if (!rawInstruments || rawInstruments.length === 0) {
      this.logger.warn(
        'No instruments provided for refresh; skipping. ' +
          'The broker adapter should supply the instrument list.',
      );
      return 0;
    }

    const count = await this.repository.bulkUpsertInstruments(rawInstruments);
    this.logger.log(`Upserted ${count} instruments into database`);

    // Reload the in-memory cache
    await this.loadFromDatabase();
    this.lastRefreshedAt = new Date();
    this.logger.log(
      `Instrument cache refreshed with ${this.instrumentsByToken.size} instruments`,
    );

    return count;
  }

  /**
   * Get the timestamp of the last successful master refresh.
   */
  getLastRefreshedAt(): Date | null {
    return this.lastRefreshedAt;
  }

  /**
   * Get total cached instrument count.
   */
  getCachedCount(): number {
    return this.instrumentsByToken.size;
  }

  /**
   * Load all active instruments from the database into the in-memory cache
   * AND proactively seed the candle-aggregator's token→instrumentId map.
   *
   * This is critical for live-tick ingestion across all exchanges (NSE, NFO,
   * BSE, MCX). Previously this used searchInstruments('') which is capped at
   * `take: 50` — that silently dropped every instrument beyond the first 50
   * rows alphabetically, so tokens for MCX commodities (CRUDEOIL/COPPER) and
   * most NFO options never got a cache entry and their ticks were discarded
   * by CandleAggregator.processTick (which bails when tokenInstrumentMap has
   * no match for the tick's token).
   *
   * We now pull the full active set via the dedicated repository method and
   * seed BOTH maps in lockstep so every tradable token has a mapping ready
   * before the first tick arrives.
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      const instruments = await this.repository.getAllActiveInstruments();
      this.instrumentsByToken.clear();
      this.instrumentsByExchangeToken.clear();
      let seeded = 0;
      for (const inst of instruments) {
        const record = inst as InstrumentRecord;
        this.instrumentsByToken.set(record.token, record);
        this.instrumentsByExchangeToken.set(`${record.exchange}:${record.token}`, record);
        // Push into the candle-aggregator so live ticks for this token
        // are aggregated into candles and persisted. Without this, MCX
        // commodity ticks (and any instrument outside the first 50 rows)
        // hit processTick with instrumentId=undefined and get dropped.
        this.candleAggregator.setTokenInstrumentId(record.token, record.id);
        seeded++;
      }
      this.logger.log(
        `Seeded candle-aggregator tokenInstrumentMap with ${seeded} instruments across all exchanges (NSE, NFO, BSE, MCX).`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load instruments from DB: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
