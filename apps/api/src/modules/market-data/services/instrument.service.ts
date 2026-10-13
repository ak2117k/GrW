import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MarketDataRepository,
  UpsertInstrumentInput,
} from '../repositories/market-data.repository';
import { CandleAggregatorService } from './candle-aggregator.service';
import { INDICES } from '@td/shared/constants';
import { CORE_INDEX_INSTRUMENTS, INDEX_SEGMENTS } from './core-index-instruments';

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

  /**
   * Rows per round trip when warming the cache.
   *
   * Sized to bound the transient, not to minimise round trips. The whole point
   * is that no single result set can be large enough to exhaust memory however
   * far the table grows, so this stays a constant rather than a fraction of the
   * row count.
   */
  static readonly LOAD_PAGE_SIZE = 5_000;

  /**
   * DELIBERATELY NOT AWAITED — the port bind depends on it.
   *
   * Nest awaits every `onModuleInit` in the tree before `app.listen()` runs, so
   * awaiting this put a full-table read of `instruments` directly in front of
   * the port. Render's health check then had nothing to answer it, and the
   * deploy failed. The application was fine; it never got to listen. This is the
   * same hazard, and the same fix, as the boot instrument-master refresh next
   * door in `instrument-master-refresh.cron.ts`.
   *
   * Detaching is safe because every read path already tolerates a cold cache:
   * `getByToken` falls back to a single-row database read and memoises it, and
   * `search` falls back to a query when the map is empty. The only cost is a
   * window after boot in which candle aggregation has not yet been seeded for
   * every token — strictly better than the alternative, which was not serving.
   */
  onModuleInit(): void {
    void this.loadCacheFromDatabase();
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
    await this.loadCacheFromDatabase();
    this.lastRefreshedAt = new Date();
    this.logger.log(
      `Instrument cache refreshed with ${this.instrumentsByToken.size} instruments`,
    );

    return count;
  }

  /**
   * Make sure every core index (CORE_INDEX_INSTRUMENTS) has its canonical row,
   * and that the row is in the in-memory caches + candle-aggregator map.
   *
   * The master refresh never writes index rows (they are AMXIDX in the scrip
   * master and fall through its cash and derivative filters), which is why the
   * scanner, level book and daily backfill all skipped NIFTY/BANKNIFTY/FINNIFTY
   * in production. This pass is idempotent and WRITE-FREE when the rows are
   * already right — important because `lastMasterRefreshAt` reads the newest
   * `updatedAt`, and a pass that touched rows on every boot would make the boot
   * master refresh think the table was always fresh.
   *
   * A token already owned by a DIFFERENT symbol is left alone (warned): a second
   * row for the same exchange:token would make token lookups ambiguous.
   * Never throws; returns how many rows it wrote.
   */
  async ensureCoreIndexInstruments(): Promise<number> {
    let written = 0;
    for (const def of CORE_INDEX_INSTRUMENTS) {
      try {
        const existing = (await this.repository.findInstrumentsByExchangeToken(
          def.exchange,
          def.token,
        )) as Array<InstrumentRecord & { isActive?: boolean }>;
        const canonical = existing.find((r) => r.symbol === def.symbol);
        let record: InstrumentRecord | null = null;
        if (canonical && canonical.isActive !== false && INDEX_SEGMENTS.has(canonical.segment)) {
          record = canonical;
        } else if (!canonical && existing.length > 0) {
          this.logger.warn(
            `Core index ${def.symbol} (${def.exchange}:${def.token}) is held by ` +
              `${existing.map((r) => `'${r.symbol}'`).join(', ')}; not adding a duplicate-token row. ` +
              `Lookups by symbol '${def.symbol}' will miss until that row is renamed.`,
          );
          continue;
        } else {
          record = (await this.repository.upsertInstrument(def)) as InstrumentRecord;
          written++;
        }
        this.instrumentsByToken.set(record.token, record);
        this.instrumentsByExchangeToken.set(`${record.exchange}:${record.token}`, record);
        this.candleAggregator.setTokenInstrumentId(record.token, record.id);
      } catch (err) {
        this.logger.warn(
          `ensureCoreIndexInstruments ${def.symbol} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (written > 0) this.logger.log(`Core index instruments: ${written} row(s) created/repaired`);
    return written;
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
   * Warm the in-memory cache by WALKING the table in bounded pages, seeding the
   * candle-aggregator's token→instrumentId map in lockstep.
   *
   * Both maps must cover the FULL active set, which is why this pages rather
   * than simply capping the read. An earlier version used `searchInstruments('')`,
   * capped at `take: 50`, and silently dropped every instrument past the first
   * 50 rows alphabetically — so MCX commodities (CRUDEOIL/COPPER) and most NFO
   * options had no cache entry and their ticks were discarded by
   * `CandleAggregator.processTick`, which bails when the map has no match for a
   * tick's token. Paging keeps that coverage while bounding the cost of getting it.
   *
   * Replacing the cap with one unbounded `findMany` is what then exhausted
   * memory: the row count went from thousands to a scale where the database, the
   * driver and the client each hold the entire result at once — once the master
   * began carrying live derivative contracts. Paging caps that transient at
   * `LOAD_PAGE_SIZE` rows regardless of how large the table grows.
   *
   * The maps are populated INCREMENTALLY rather than built aside and swapped in.
   * A swap would double peak memory at exactly the moment memory is the
   * constraint — and since this now runs detached, behind an already-listening
   * server, a half-filled cache is a state readers must tolerate anyway. They
   * do: a miss falls back to a single-row read.
   *
   * Never throws. A failed page leaves the pages already read in place, which
   * still serves lookups; the alternative — an empty cache — is strictly worse.
   */
  async loadCacheFromDatabase(): Promise<void> {
    const startedAt = Date.now();
    this.instrumentsByToken.clear();
    this.instrumentsByExchangeToken.clear();
    let seeded = 0;
    let cursorId: string | undefined;

    try {
      for (;;) {
        const page = await this.repository.getActiveInstrumentPage(
          InstrumentService.LOAD_PAGE_SIZE,
          cursorId,
        );
        for (const inst of page) {
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
        // A short page is the last page — asking again only to be told the walk
        // is over costs a round trip on every boot.
        if (page.length < InstrumentService.LOAD_PAGE_SIZE) break;
        cursorId = (page[page.length - 1] as InstrumentRecord).id;
      }
      this.logger.log(
        `Instrument cache warmed with ${seeded} instruments across all exchanges ` +
          `(NSE, NFO, BSE, MCX) in ${Date.now() - startedAt}ms, ` +
          `${InstrumentService.LOAD_PAGE_SIZE} rows per page.`,
      );
    } catch (error) {
      // Logged with the count so a partial warm is legible as partial rather
      // than reading as a total failure.
      this.logger.error(
        `Instrument cache warm stopped after ${seeded} instruments: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
