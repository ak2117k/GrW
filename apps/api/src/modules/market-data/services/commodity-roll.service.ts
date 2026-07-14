import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { COMMODITIES } from '@td/shared/constants';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from './angel-one-adapter.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { MarketDataRepository } from '../repositories/market-data.repository';
import { MarketFeedService } from './market-feed.service';

const SCRIPMASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

/**
 * After a token roll, how many days of daily candles to backfill for the
 * new contract. 30 is enough for the level book's PDH/PDL/atr14 path
 * (level-book seeds from the most-recent ~20 daily candles).
 */
const POST_ROLL_DAILY_BACKFILL_DAYS = 30;

/** Per-commodity roll outcome — one entry per tracked symbol. */
export interface CommodityRollResult {
  symbol: string;
  status:
    | 'NOOP'
    | 'ROLLED'
    | 'CREATED'
    | 'NO_FRONT_MONTH'
    | 'NO_DB_ROW'
    | 'WOULD_CREATE'
    | 'ERROR'
    | 'DRY_RUN';
  oldToken?: string;
  newToken?: string;
  oldContractSymbol?: string;
  newContractSymbol?: string;
  newContractExpiry?: string;
  oldCandlesCleared?: number;
  newCandlesBackfilled?: number;
  levelBookInvalidated?: boolean;
  wsResubscribed?: boolean;
  error?: string;
}

interface ScripMasterEntry {
  exch_seg?: string;
  instrumenttype?: string;
  name?: string;
  symbol?: string;
  token?: string | number;
  expiry?: string;
  lotsize?: string | number;
}

/**
 * MCX commodity FUTCOM contracts roll every month. When the front-month
 * contract expires (typically the 19th-20th of the expiry month), our
 * tracked instrument row keeps pointing at the dead contract — visible
 * symptoms: chart shows stale prices, intraday candles stop arriving,
 * PDH/PDL get stuck on pre-expiry values.
 *
 * This service detects the front-month for each tracked commodity from
 * Angel One's public ScripMaster, compares to what's in the DB, and
 * rolls atomically when they diverge:
 *
 *   1. Wipe old candles for the instrument row (different price series).
 *   2. Update the row's `token` (and lotSize if changed).
 *   3. Sync the in-memory `COMMODITIES` constant.
 *   4. Backfill `POST_ROLL_DAILY_BACKFILL_DAYS` of daily candles so the
 *      level book has enough history to seed PDH/PDL/atr14 immediately.
 *   5. Invalidate the cached level book for that token.
 *   6. Swap WS subscription (unsubscribe old, subscribe new) if the old
 *      token was in the live feed.
 *
 * Idempotent: if the DB token already matches today's front-month, the
 * commodity is reported NOOP and nothing else happens.
 *
 * Wired up two ways:
 *   - Daily cron at 08:30 IST (via CommodityRollCron) — before MCX 09:00 open.
 *   - Manual trigger via POST /api/market-data/commodity-roll/trigger.
 */
/** A commodity's currently-live front-month contract. */
export interface FrontMonthContract {
  symbol: string;
  token: string;
  exchange: 'MCX';
  contractSymbol: string;
  expiry: string;
}

/** How long a resolved front-month set is cached before re-fetching the ~30MB ScripMaster. */
const FRONT_MONTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

@Injectable()
export class CommodityRollService {
  private readonly logger = new Logger(CommodityRollService.name);

  /** Cache of resolved front-month contracts so the direct-quote path never pulls the 30MB ScripMaster per request. */
  private frontMonthCache: { at: number; contracts: FrontMonthContract[] } | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly adapter: AngelOneAdapterService,
    private readonly repository: MarketDataRepository,
    @Optional() private readonly levelBookService: LevelBookService | null,
    @Optional() private readonly marketFeedService: MarketFeedService | null,
  ) {}

  /**
   * Resolve the current front-month contract for every tracked commodity from
   * the Angel ScripMaster. Cached for FRONT_MONTH_CACHE_TTL_MS so the direct
   * commodities-quote endpoint never pulls the ~30MB master per request. This
   * is read-only (the resolution half of a roll, with no DB writes) and is what
   * lets commodities be shown/charted straight from Angel without a DB row or
   * feed subscription. Returns the last good cache (or []) if the fetch fails.
   */
  async resolveFrontMonthTokens(): Promise<FrontMonthContract[]> {
    if (this.frontMonthCache && Date.now() - this.frontMonthCache.at < FRONT_MONTH_CACHE_TTL_MS) {
      return this.frontMonthCache.contracts;
    }
    let master: ScripMasterEntry[];
    try {
      master = await this.fetchScripMaster();
    } catch (err) {
      this.logger.warn(
        `resolveFrontMonthTokens: ScripMaster fetch failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.frontMonthCache?.contracts ?? [];
    }
    const contracts: FrontMonthContract[] = [];
    for (const symbol of Object.keys(COMMODITIES)) {
      const front = this.pickFrontMonth(master, symbol);
      if (front) {
        contracts.push({
          symbol,
          token: String(front.token),
          exchange: 'MCX',
          contractSymbol: front.symbol ?? '',
          expiry: front.expiry ?? '',
        });
      }
    }
    this.frontMonthCache = { at: Date.now(), contracts };
    this.logger.log(`resolveFrontMonthTokens: resolved ${contracts.length}/${Object.keys(COMMODITIES).length} commodities`);
    return contracts;
  }

  /**
   * Run a roll across all (or a subset of) tracked commodities.
   *
   * @param opts.dryRun       — if true, detect changes but make no DB writes
   *                            and trigger no side effects. Useful for ops.
   * @param opts.symbols      — restrict to these symbols (uppercased). Default:
   *                            all keys of COMMODITIES.
   */
  async runRoll(opts: { dryRun?: boolean; symbols?: string[] } = {}): Promise<CommodityRollResult[]> {
    const dryRun = !!opts.dryRun;
    const trackedSymbols = (opts.symbols ?? Object.keys(COMMODITIES)).map((s) => s.toUpperCase());

    this.logger.log(
      `Commodity roll starting${dryRun ? ' (DRY RUN)' : ''} — symbols: ${trackedSymbols.join(', ')}`,
    );

    let master: ScripMasterEntry[];
    try {
      master = await this.fetchScripMaster();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`ScripMaster fetch failed — aborting roll: ${message}`);
      return trackedSymbols.map((symbol) => ({ symbol, status: 'ERROR' as const, error: message }));
    }

    const results: CommodityRollResult[] = [];
    for (const symbol of trackedSymbols) {
      try {
        results.push(await this.rollOne(master, symbol, dryRun));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Roll failed for ${symbol}: ${message}`);
        results.push({ symbol, status: 'ERROR', error: message });
      }
    }

    const rolledCount = results.filter((r) => r.status === 'ROLLED').length;
    this.logger.log(
      `Commodity roll complete — ${rolledCount}/${results.length} rolled` +
      (dryRun ? ' (DRY RUN — no writes)' : ''),
    );
    return results;
  }

  private async rollOne(
    master: ScripMasterEntry[],
    symbol: string,
    dryRun: boolean,
  ): Promise<CommodityRollResult> {
    const front = this.pickFrontMonth(master, symbol);
    if (!front) {
      this.logger.warn(`${symbol}: no front-month FUTCOM found in ScripMaster`);
      return { symbol, status: 'NO_FRONT_MONTH' };
    }

    const newToken = String(front.token);
    const newContractSymbol = front.symbol ?? '';
    const newContractExpiry = front.expiry ?? '';

    const row = await this.prisma.instrument.findFirst({
      where: { symbol, exchange: 'MCX' },
      select: { id: true, token: true, symbol: true, lotSize: true },
    });
    if (!row) {
      // First-time seed. No instrument row exists for this commodity yet, so
      // there is nothing to "roll" — we CREATE the row at today's front-month
      // token. (This branch used to bail with NO_DB_ROW, which is exactly why
      // the Commodities tab was empty on a fresh DB: the roll only ever updated
      // pre-existing rows, and the manual seed script was never run.)
      if (dryRun) {
        return { symbol, status: 'WOULD_CREATE', newToken, newContractSymbol, newContractExpiry };
      }

      const created = await this.prisma.instrument.upsert({
        where: { symbol_exchange_token: { symbol, exchange: 'MCX', token: newToken } },
        create: {
          symbol,
          name: symbol,
          token: newToken,
          exchange: 'MCX',
          segment: 'COMMODITY',
          lotSize: Number(front.lotsize) || 1,
          isActive: true,
        },
        update: { isActive: true },
        select: { id: true },
      });

      // Sync the in-memory COMMODITIES constant so the feed routes ticks to the
      // right token immediately.
      const constEntry = (COMMODITIES as Record<string, { symbol: string; token: string }>)[symbol];
      if (constEntry) {
        constEntry.token = newToken;
      }

      const backfilled = await this.backfillDailyCandles(created.id, newToken, symbol);

      let wsSubscribed = false;
      if (this.marketFeedService) {
        try {
          await this.marketFeedService.subscribe([newToken]);
          wsSubscribed = true;
        } catch (err) {
          this.logger.warn(
            `${symbol}: WS subscribe after seed failed — ${err instanceof Error ? err.message : String(err)}.`,
          );
        }
      }

      this.logger.log(
        `${symbol}: seeded instrument row at ${newToken} (${newContractSymbol}, expiry ` +
        `${newContractExpiry}), backfilled ${backfilled} daily candles`,
      );
      return {
        symbol,
        status: 'CREATED',
        newToken,
        newContractSymbol,
        newContractExpiry,
        newCandlesBackfilled: backfilled,
        wsResubscribed: wsSubscribed,
      };
    }

    if (row.token === newToken) {
      return {
        symbol,
        status: 'NOOP',
        oldToken: row.token,
        newToken,
        newContractSymbol,
        newContractExpiry,
      };
    }

    if (dryRun) {
      this.logger.log(
        `${symbol}: would roll ${row.token} → ${newToken} (${newContractSymbol}, expiry ${newContractExpiry})`,
      );
      return {
        symbol,
        status: 'DRY_RUN',
        oldToken: row.token,
        newToken,
        newContractSymbol,
        newContractExpiry,
      };
    }

    this.logger.log(
      `${symbol}: rolling ${row.token} → ${newToken} (${newContractSymbol}, expiry ${newContractExpiry})`,
    );

    // 1. Wipe old candles — they belong to the previous (now-different) price series.
    const deleted = await this.prisma.candle.deleteMany({ where: { instrumentId: row.id } });

    // 2. Update DB row to point at the new contract.
    await this.prisma.instrument.update({
      where: { id: row.id },
      data: {
        token: newToken,
        lotSize: Number(front.lotsize) || row.lotSize,
        isActive: true,
      },
    });

    // 3. Sync the in-memory COMMODITIES constant so the broker adapter routes
    //    ticks to the right exchange WS (it checks membership in COMMODITIES).
    const constEntry = (COMMODITIES as Record<string, { symbol: string; token: string }>)[symbol];
    if (constEntry) {
      constEntry.token = newToken;
    }

    // 4. Backfill recent daily candles so PDH/PDL/atr14 work immediately.
    const backfilled = await this.backfillDailyCandles(row.id, newToken, symbol);

    // 5. Drop the cached level book so the next read rebuilds from new candles.
    let levelBookInvalidated = false;
    if (this.levelBookService) {
      levelBookInvalidated = this.levelBookService.invalidate(newToken);
      // Also try the OLD token in case anything cached against it.
      this.levelBookService.invalidate(row.token);
    }

    // 6. Swap WS subscription. If the old token was in the live feed, we
    //    need to unsubscribe it and subscribe the new one — otherwise live
    //    ticks keep flowing to the dead contract until the next API restart.
    let wsResubscribed = false;
    if (this.marketFeedService) {
      try {
        const unsubscribed = await this.marketFeedService.unsubscribe([row.token]);
        if (unsubscribed.length > 0) {
          await this.marketFeedService.subscribe([newToken]);
          wsResubscribed = true;
        }
      } catch (err) {
        this.logger.warn(
          `${symbol}: WS swap failed — ${err instanceof Error ? err.message : String(err)}. ` +
          `Live feed will be stale until next API restart.`,
        );
      }
    }

    return {
      symbol,
      status: 'ROLLED',
      oldToken: row.token,
      newToken,
      oldContractSymbol: row.symbol,
      newContractSymbol,
      newContractExpiry,
      oldCandlesCleared: deleted.count,
      newCandlesBackfilled: backfilled,
      levelBookInvalidated,
      wsResubscribed,
    };
  }

  /**
   * Backfill the most-recent POST_ROLL_DAILY_BACKFILL_DAYS of daily candles for
   * a freshly created OR freshly rolled commodity instrument. Non-fatal: on
   * failure it logs and returns however many it managed to persist, so the
   * caller's create/roll still succeeds (lazy chart fetches fill any gap).
   * Returns the number of daily candles upserted.
   */
  private async backfillDailyCandles(
    instrumentId: string,
    token: string,
    symbol: string,
  ): Promise<number> {
    let backfilled = 0;
    try {
      const to = new Date();
      const from = new Date(to.getTime() - POST_ROLL_DAILY_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
      const rows = await this.adapter.getHistoricalData(token, 'MCX', '1d', from, to);
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map((c: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }) =>
            this.repository.upsertCandle({
              instrumentId,
              timeframe: '1d',
              timestamp: new Date(c.timestamp),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume) || 0,
            }),
          ),
        );
        backfilled += chunk.length;
      }
    } catch (err) {
      this.logger.warn(
        `${symbol}: daily backfill failed — ${err instanceof Error ? err.message : String(err)}. ` +
        `Data will fill in via lazy chart fetches.`,
      );
    }
    return backfilled;
  }

  /**
   * Pick the front-month FUTCOM record on MCX for a given commodity name —
   * smallest expiry that is still >= today (UTC midnight). Returns null if
   * nothing matches (shouldn't happen for a liquid commodity).
   */
  private pickFrontMonth(master: ScripMasterEntry[], name: string): ScripMasterEntry | null {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const candidates = master
      .filter(
        (r) =>
          r.exch_seg === 'MCX' &&
          r.instrumenttype === 'FUTCOM' &&
          r.name === name,
      )
      .map((r) => ({ entry: r, expiry: this.parseExpiry(r.expiry) }))
      .filter((c) => c.expiry && c.expiry >= today)
      .sort((a, b) => (a.expiry as Date).getTime() - (b.expiry as Date).getTime());

    return candidates[0]?.entry ?? null;
  }

  /**
   * Angel One's expiry strings look like "29MAY2026". Parse to a Date at
   * UTC midnight so day-granularity comparisons are timezone-safe.
   */
  private parseExpiry(s: string | undefined): Date | null {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
    if (!m) return null;
    const [, dd, mon, yyyy] = m;
    const months: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const monthIdx = months[mon];
    if (monthIdx === undefined) return null;
    return new Date(Date.UTC(Number(yyyy), monthIdx, Number(dd)));
  }

  /**
   * Fetch the public ScripMaster JSON. ~30MB download — only invoked once
   * per cron tick (daily) or per manual trigger so no caching needed.
   * Browser-shaped User-Agent because Angel sometimes blocks plain Node.
   */
  private async fetchScripMaster(): Promise<ScripMasterEntry[]> {
    const response = await firstValueFrom(
      this.http.get<ScripMasterEntry[]>(SCRIPMASTER_URL, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'application/json',
        },
        timeout: 60_000,
        // ScripMaster JSON is ~30MB; default axios maxContentLength is 10MB which would truncate.
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
      }),
    );
    if (!Array.isArray(response.data)) {
      throw new Error('ScripMaster response is not an array');
    }
    return response.data;
  }
}
