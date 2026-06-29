import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  BrokerAdapter,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { NseOptionsChainService } from './nse-options-chain.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { OptionsChainEntry, OptionData, OptionType } from '@td/shared/types';
import { COMMODITIES } from '@td/shared/constants';

/**
 * MCX commodity underlyings that trade options-on-futures. Used to branch
 * the chain-build path away from NSE-specific sources (which don't apply
 * to commodities) and toward the Angel One master + per-strike live-quote
 * path.
 */
const MCX_COMMODITIES: ReadonlySet<string> = new Set([
  'CRUDEOIL',
  'COPPER',
  'GOLD',
  'SILVER',
  'NATURALGAS',
]);

/** Index token map for spot price lookups on NSE indices. */
const INDEX_SPOT_TOKENS: Record<string, { token: string; exchange: string }> = {
  NIFTY: { token: '99926000', exchange: 'NSE' },
  BANKNIFTY: { token: '99926009', exchange: 'NSE' },
  FINNIFTY: { token: '99926037', exchange: 'NSE' },
  MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
};

const DEFAULT_RISK_FREE_RATE = 0.065;

/**
 * In-memory cache for option contracts fetched from the Angel One master list.
 * Keyed by uppercase underlying (e.g., "NIFTY").
 * Expires after CACHE_TTL_MS to ensure we pick up new expiries.
 */
interface CachedContracts {
  contracts: OptionContract[];
  fetchedAt: number;
}

interface OptionContract {
  token: string;
  symbol: string;
  name: string;
  exchange: string;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number;
}

/** Cache TTL: 30 minutes */
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface OISummary {
  totalCEOI: number;
  totalPEOI: number;
  pcr: number;
  maxPainStrike: number;
  highestCEOIStrike: number;
  highestPEOIStrike: number;
}

@Injectable()
export class OptionsChainService {
  private readonly logger = new Logger(OptionsChainService.name);

  /** In-memory cache for option contracts by underlying. */
  private contractsCache = new Map<string, CachedContracts>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly greeksCalculator: GreeksCalculatorService,
    private readonly nseChain: NseOptionsChainService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly authService: AngelOneAuthService,
    @Optional()
    private readonly marketFeed: MarketFeedService | null,
  ) {}

  /** True for symbols that trade MCX commodity options (OPTFUT). */
  private isMcxUnderlying(underlying: string): boolean {
    return MCX_COMMODITIES.has(underlying.toUpperCase());
  }

  /**
   * Resolve the current spot price for either NSE indices or MCX commodities.
   * For MCX we use the front-month future's LTP (from the COMMODITIES token map)
   * as the spot — that's how commodity options are priced in practice.
   */
  private async getSpotForUnderlying(underlying: string): Promise<number> {
    const upper = underlying.toUpperCase();

    // MCX: use the front-month future as spot.
    if (this.isMcxUnderlying(upper)) {
      const cmd = COMMODITIES[upper];
      if (!cmd) return 0;

      // 1) Try the in-memory feed cache (hot path).
      if (this.marketFeed) {
        const cached = this.marketFeed.getQuote(cmd.token);
        if (cached && cached.ltp > 0) return cached.ltp;
      }

      // 2) Fall back to a direct broker REST quote.
      if (this.brokerAdapter) {
        try {
          const q = await this.brokerAdapter.getLiveQuote(cmd.token, 'MCX');
          if (q?.ltp > 0) return q.ltp;
        } catch (err) {
          this.logger.debug(
            `MCX spot lookup failed for ${upper}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
      return 0;
    }

    // NSE indices
    const idx = INDEX_SPOT_TOKENS[upper];
    if (idx && this.brokerAdapter) {
      try {
        const q = await this.brokerAdapter.getLiveQuote(idx.token, idx.exchange);
        if (q?.ltp > 0) return q.ltp;
      } catch {
        // fall through
      }
    }
    return 0;
  }

  /**
   * Get available expiry dates for an underlying symbol.
   * Tries DB first, falls back to fetching from Angel One instrument master.
   */
  async getExpiries(underlying: string): Promise<string[]> {
    // 1. Snapshots are the ground truth — they only exist for expiries we
    // actually have data for, so the expiry list matches what the chain
    // fetch can serve. This also dodges the local-time→UTC off-by-one in
    // the instrument-master path (where a Monday expiry stored in local
    // midnight becomes the prior Sunday after `.toISOString()`).
    const snapshotExpiries = await this.getExpiriesFromSnapshots(underlying);
    if (snapshotExpiries.length > 0) {
      return snapshotExpiries;
    }

    // 2. Try the instrument DB
    const dbExpiries = await this.getExpiriesFromDB(underlying);
    if (dbExpiries.length > 0) {
      return dbExpiries;
    }

    // 2. Fall back to Angel One instrument master
    const contracts = await this.getOptionContracts(underlying);
    if (contracts.length === 0) {
      return [];
    }

    // Extract unique expiry dates, filter to future dates, sort ascending.
    // Angel One master expiries are parsed at local midnight; use the local
    // Y-M-D string rather than toISOString() so Monday 27-APR doesn't slip
    // to Sunday 26-APR when the UTC offset crosses midnight.
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const localYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const expirySet = new Set<string>();
    for (const c of contracts) {
      if (c.expiry >= now) {
        expirySet.add(
          this.isMcxUnderlying(underlying)
            ? localYmd(c.expiry)
            : c.expiry.toISOString().split('T')[0],
        );
      }
    }

    const expiries = Array.from(expirySet).sort();
    this.logger.log(
      `Found ${expiries.length} expiries for ${underlying} from instrument master`,
    );

    return expiries;
  }

  /**
   * Build the full options chain for a given underlying and expiry date.
   * Uses DB instruments if available, otherwise fetches from Angel One master.
   */
  async getOptionsChain(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    const { chain } = await this.getOptionsChainWithSpot(underlying, expiry);
    return chain;
  }

  async getOptionsChainWithSpot(
    underlying: string,
    expiry: string,
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number }> {
    // MCX branch: NSE chain API does not apply to commodity options, and
    // the `instrument` DB table is populated only for NFO instruments.
    // Go straight to snapshot → master-backed chain.
    if (this.isMcxUnderlying(underlying)) {
      return this.getMcxOptionsChainWithSpot(underlying, expiry);
    }

    // 1. Fresh snapshot captured today → serve instantly. During market hours
    // a background refresh worker overwrites these; on weekends the bootstrap
    // script holds Friday-close data. Either way, the DB is the fast path.
    const todaysSnapshot = await this.loadTodaysSnapshot(underlying, expiry);
    if (todaysSnapshot) {
      this.logger.log(
        `Serving today's snapshot for ${underlying} ${expiry} (source=${todaysSnapshot.source})`,
      );
      return {
        chain: this.enrichGreeks(todaysSnapshot.chain, todaysSnapshot.spotPrice, expiry),
        spotPrice: todaysSnapshot.spotPrice,
      };
    }

    // 2. NSE public chain API — authoritative OI/volume/IV in one call.
    // Guarded by a short timeout so a slow/blocked NSE response doesn't
    // stall the request path for ~70 s (Akamai TLS-fingerprint block).
    const nseResult = await this.withTimeout(
      this.nseChain.getChain(underlying, expiry),
      3000,
      'NSE direct fetch',
    );
    if (nseResult && nseResult.chain.length > 0) {
      const enriched = this.enrichGreeks(nseResult.chain, nseResult.spotPrice, expiry);
      void this.persistSnapshot(underlying, expiry, enriched, nseResult.spotPrice, 'NSE');
      return { chain: enriched, spotPrice: nseResult.spotPrice };
    }

    // 3. Angel One live via broker adapter (market-hours path).
    const dbChain = await this.getChainFromDB(underlying, expiry);
    if (dbChain.length > 0 && this.chainHasRealData(dbChain)) {
      const dbSpot = this.spotFromChain(dbChain);
      void this.persistSnapshot(underlying, expiry, dbChain, dbSpot, 'ANGEL_ONE');
      return { chain: dbChain, spotPrice: dbSpot };
    }

    // 4. Read-fallback: any snapshot within 7 days. Covers the case where
    // no fresh snapshot exists for today but last week's is still relevant.
    const snapshot = await this.loadLatestSnapshot(underlying, expiry);
    if (snapshot) {
      this.logger.log(
        `Serving persisted snapshot for ${underlying} ${expiry} from ${snapshot.capturedAt.toISOString()} (source=${snapshot.source})`,
      );
      return {
        chain: this.enrichGreeks(snapshot.chain, snapshot.spotPrice, expiry),
        spotPrice: snapshot.spotPrice,
      };
    }

    // 5. Last resort: synthetic chain from instrument master.
    const fallbackChain = dbChain.length > 0 ? dbChain : await this.getChainFromMaster(underlying, expiry);
    return { chain: fallbackChain, spotPrice: 0 };
  }

  /**
   * MCX-specific chain builder. The NSE public chain API doesn't cover
   * commodities, and the `instrument` DB is NFO-only, so the path is:
   *
   *   1) today's snapshot
   *   2) 7-day read-fallback snapshot
   *   3) live build from Angel One MCX master + per-strike live-quote
   *      (windowed to ±10 strikes around the front-month future spot so the
   *      REST fan-out stays sane).
   */
  private async getMcxOptionsChainWithSpot(
    underlying: string,
    expiry: string,
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number }> {
    // 1. Today's snapshot — same freshness gate as NSE path.
    const todaysSnapshot = await this.loadTodaysSnapshot(underlying, expiry);
    if (todaysSnapshot) {
      this.logger.log(
        `Serving today's snapshot for MCX ${underlying} ${expiry} (source=${todaysSnapshot.source})`,
      );
      return {
        chain: this.enrichGreeks(
          todaysSnapshot.chain,
          todaysSnapshot.spotPrice,
          expiry,
        ),
        spotPrice: todaysSnapshot.spotPrice,
      };
    }

    // 2. Live build from instrument master + broker live quotes.
    const spotPrice = await this.getSpotForUnderlying(underlying);
    const liveChain = await this.buildMcxChainFromMaster(
      underlying,
      expiry,
      spotPrice,
    );

    if (liveChain.length > 0 && this.chainHasRealData(liveChain)) {
      const enriched = this.enrichGreeks(liveChain, spotPrice, expiry);
      void this.persistSnapshot(
        underlying,
        expiry,
        enriched,
        spotPrice,
        'ANGEL_ONE',
      );
      return { chain: enriched, spotPrice };
    }

    // 3. 7-day read-fallback snapshot.
    const snapshot = await this.loadLatestSnapshot(underlying, expiry);
    if (snapshot) {
      this.logger.log(
        `Serving persisted snapshot for MCX ${underlying} ${expiry} from ${snapshot.capturedAt.toISOString()}`,
      );
      return {
        chain: this.enrichGreeks(snapshot.chain, snapshot.spotPrice, expiry),
        spotPrice: snapshot.spotPrice,
      };
    }

    // 4. Last resort: return the scaffold (even with zero LTPs it lets the
    // strike selector see which strikes exist).
    return { chain: liveChain, spotPrice };
  }

  /**
   * Build a live MCX options chain from the Angel One instrument master,
   * windowed to ±10 strikes around the front-month future spot so the
   * per-strike REST fan-out is bounded.
   */
  private async buildMcxChainFromMaster(
    underlying: string,
    expiry: string,
    spotPrice: number,
  ): Promise<OptionsChainEntry[]> {
    const contracts = await this.getOptionContracts(underlying);
    if (contracts.length === 0) {
      this.logger.warn(
        `MCX master returned 0 option contracts for ${underlying}`,
      );
      return [];
    }

    // Filter contracts to the requested expiry (compare on local-date parts
    // to avoid TZ drift — see getLiveOptionLtpDebug for the same approach).
    const expiryYmd = expiry.slice(0, 10);
    const localYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const forExpiry = contracts.filter((c) => localYmd(c.expiry) === expiryYmd);
    if (forExpiry.length === 0) {
      this.logger.warn(
        `No MCX contracts for ${underlying} expiry ${expiryYmd}`,
      );
      return [];
    }

    // MCX master strikes: on commodities these are typically in rupees
    // (e.g. 6500 for CRUDEOIL), unlike NFO indices which store strike in
    // paise. If the median strike is >10x spot, assume paise and rescale.
    const rawStrikes = Array.from(
      new Set(forExpiry.map((c) => c.strike)),
    ).sort((a, b) => a - b);
    let scale = 1;
    if (spotPrice > 0 && rawStrikes.length > 0) {
      const median = rawStrikes[Math.floor(rawStrikes.length / 2)];
      if (median > spotPrice * 10) scale = 100; // paise-encoded
    }
    const normalizedContracts = forExpiry.map((c) => ({
      ...c,
      strike: c.strike / scale,
    }));

    // Group by strike
    const byStrike = new Map<
      number,
      { ce: OptionContract | null; pe: OptionContract | null }
    >();
    for (const c of normalizedContracts) {
      if (!byStrike.has(c.strike)) byStrike.set(c.strike, { ce: null, pe: null });
      const entry = byStrike.get(c.strike)!;
      if (c.optionType === 'CE') entry.ce = c;
      else if (c.optionType === 'PE') entry.pe = c;
    }
    const allStrikes = Array.from(byStrike.keys()).sort((a, b) => a - b);

    // Window to ±10 strikes around spot (or the middle of the chain if
    // we have no spot). The per-strike live-quote fan-out is bounded by
    // Angel One's 10 req/sec rate limit; 21 strikes * 2 legs = 42 calls
    // sits in the safe zone.
    const WINDOW = 10;
    let atmIdx = Math.floor(allStrikes.length / 2);
    if (spotPrice > 0) {
      let bestDist = Infinity;
      for (let i = 0; i < allStrikes.length; i++) {
        const dist = Math.abs(allStrikes[i] - spotPrice);
        if (dist < bestDist) {
          bestDist = dist;
          atmIdx = i;
        }
      }
    }
    const start = Math.max(0, atmIdx - WINDOW);
    const end = Math.min(allStrikes.length, atmIdx + WINDOW + 1);
    const windowStrikes = allStrikes.slice(start, end);

    this.logger.log(
      `Building MCX chain for ${underlying} ${expiryYmd}: ` +
        `${windowStrikes.length}/${allStrikes.length} strikes around spot=${spotPrice} (scale=${scale})`,
    );

    // Time-to-expiry for Greeks
    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(23, 30, 0, 0); // MCX options expire end-of-day
    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

    // Fetch live quotes per leg. Serial to respect Angel One rate limits;
    // 42 calls at ~5/sec is ~8 seconds which is acceptable for a chain fetch.
    const chain: OptionsChainEntry[] = [];
    for (const strike of windowStrikes) {
      const { ce, pe } = byStrike.get(strike)!;
      const ceData = ce
        ? await this.buildOptionDataFromMaster(
            { ...ce, strike }, // pass normalized strike back into the builder
            spotPrice,
            strike,
            timeToExpiry,
            'CE',
          )
        : null;
      const peData = pe
        ? await this.buildOptionDataFromMaster(
            { ...pe, strike },
            spotPrice,
            strike,
            timeToExpiry,
            'PE',
          )
        : null;
      chain.push({
        strikePrice: strike,
        expiryDate: expiry,
        ceData,
        peData,
      });
    }
    chain.sort((a, b) => a.strikePrice - b.strikePrice);
    return chain;
  }

  /**
   * Resolve the broker's real LTP for a single option contract by looking up
   * its true token in the instrument master and calling getLiveQuote(). This
   * bypasses the chain-snapshot path entirely, so consumers (like the open
   * paper trade refresher) get the same number the broker terminal shows
   * instead of a delta-extrapolated estimate.
   *
   * Returns null if the contract can't be resolved or the broker call fails;
   * the caller should fall back to its own approximation.
   */
  async getLiveOptionLtp(
    underlying: string,
    expiryIso: string,
    strike: number,
    optionType: 'CE' | 'PE',
  ): Promise<number | null> {
    const result = await this.getLiveOptionLtpDebug(underlying, expiryIso, strike, optionType);
    return result.ltp;
  }

  async getLiveOptionLtpDebug(
    underlying: string,
    expiryIso: string,
    strike: number,
    optionType: 'CE' | 'PE',
  ): Promise<{ ltp: number | null; reason: string; candidates?: string[]; expiriesSeen?: string[] }> {
    if (!this.brokerAdapter) {
      return { ltp: null, reason: 'no brokerAdapter' };
    }
    const contracts = await this.getOptionContracts(underlying);
    if (contracts.length === 0) {
      return { ltp: null, reason: 'getOptionContracts returned 0' };
    }

    const expiryYmd = expiryIso.slice(0, 10);
    // Angel One's NFO master stores strike in paise (₹56,000 → 5600000) on
    // index options. Accept either a raw rupee match or a paise match (s/100).
    const strikeMatches = (s: number) =>
      Math.abs(s - strike) < 0.01 || Math.abs(s / 100 - strike) < 0.01;

    // The Angel One master parses expiries via new Date(year, mon, day) which
    // creates a local-midnight Date. .toISOString() shifts that back into UTC,
    // so a Tuesday 28-APR expiry stored at IST midnight serializes as the
    // previous day in UTC ("2026-04-27"). Compare against the local-time
    // date components so 28-APR matches 28-APR regardless of TZ representation.
    const localYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const sameType = contracts.filter((c) => c.optionType === optionType);
    const expiriesSeen = Array.from(
      new Set(sameType.map((c) => localYmd(c.expiry))),
    ).sort();
    const candidates = sameType.filter((c) => localYmd(c.expiry) === expiryYmd);
    const match = candidates.find((c) => strikeMatches(c.strike));

    if (!match) {
      const sample = candidates
        .slice(0, 8)
        .map((c) => `${c.symbol}@${c.strike}`);
      return {
        ltp: null,
        reason: `no strike match for ${expiryYmd} ${strike}${optionType}; ${candidates.length} candidates of ${sameType.length} same-type total`,
        candidates: sample,
        expiriesSeen: expiriesSeen.slice(0, 10),
      };
    }

    try {
      const tick = await this.brokerAdapter.getLiveQuote(match.token, match.exchange);
      const ltp = tick?.ltp;
      if (typeof ltp === 'number' && ltp > 0) {
        return { ltp, reason: `ok via token ${match.token}` };
      }
      return { ltp: null, reason: `broker returned ltp=${ltp} for token ${match.token}` };
    } catch (err) {
      return {
        ltp: null,
        reason: `broker call threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(`${label} timed out after ${ms}ms`);
        resolve(null);
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async loadTodaysSnapshot(
    underlying: string,
    expiry: string,
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number; source: string } | null> {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const row = await this.prisma.optionChainSnapshot.findFirst({
      where: {
        underlying: underlying.toUpperCase(),
        expiryDate: new Date(expiry),
        capturedAt: { gte: dayStart },
      },
      orderBy: { capturedAt: 'desc' },
    });
    if (!row) return null;

    // Freshness gate: during market hours (9:15–15:30 IST, Mon–Fri) the snapshot
    // must be at most SNAPSHOT_FRESHNESS_MS old, otherwise we fall through to a
    // live NSE re-fetch. Without this, the first snapshot of the day is served
    // for the rest of the session and live LTPs never propagate to consumers
    // like OpenPaperTradeRefresherWorker.
    const SNAPSHOT_FRESHNESS_MS = 60 * 1000;
    const ageMs = Date.now() - row.capturedAt.getTime();
    if (this.isMarketHoursIST() && ageMs > SNAPSHOT_FRESHNESS_MS) {
      return null;
    }

    return {
      chain: row.chainJson as unknown as OptionsChainEntry[],
      spotPrice: Number(row.spotPrice),
      source: row.source,
    };
  }

  private isMarketHoursIST(): boolean {
    const nowUtcMs = Date.now();
    const istMs = nowUtcMs + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const dow = ist.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }

  /**
   * A chain has "real" data when at least one leg carries non-zero OI or LTP.
   * On weekends / pre-market, the Angel One adapter returns all-zero rows;
   * those are worth showing as a scaffold but not worth persisting.
   */
  private chainHasRealData(chain: OptionsChainEntry[]): boolean {
    for (const entry of chain) {
      if ((entry.ceData?.oi ?? 0) > 0 || (entry.peData?.oi ?? 0) > 0) return true;
      if ((entry.ceData?.ltp ?? 0) > 0 || (entry.peData?.ltp ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * Estimate spot from a chain: strike whose combined CE+PE LTP is closest to
   * the classical intrinsic-value minimum (put-call parity heuristic). Good
   * enough for persistence metadata; exact value isn't load-bearing.
   */
  private spotFromChain(chain: OptionsChainEntry[]): number {
    if (chain.length === 0) return 0;
    let best = chain[0];
    let bestGap = Infinity;
    for (const entry of chain) {
      const ce = entry.ceData?.ltp ?? 0;
      const pe = entry.peData?.ltp ?? 0;
      const gap = Math.abs(ce - pe);
      if (gap < bestGap && (ce > 0 || pe > 0)) {
        bestGap = gap;
        best = entry;
      }
    }
    return best.strikePrice;
  }

  private async persistSnapshot(
    underlying: string,
    expiry: string,
    chain: OptionsChainEntry[],
    spotPrice: number,
    source: 'NSE' | 'ANGEL_ONE' | 'ANGEL_ONE_WS',
  ): Promise<void> {
    try {
      await this.prisma.optionChainSnapshot.create({
        data: {
          underlying: underlying.toUpperCase(),
          expiryDate: new Date(expiry),
          spotPrice,
          source,
          strikeCount: chain.length,
          chainJson: chain as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist chain snapshot for ${underlying} ${expiry}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private async loadLatestSnapshot(
    underlying: string,
    expiry: string,
  ): Promise<{ chain: OptionsChainEntry[]; capturedAt: Date; source: string; spotPrice: number } | null> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const row = await this.prisma.optionChainSnapshot.findFirst({
      where: {
        underlying: underlying.toUpperCase(),
        expiryDate: new Date(expiry),
        capturedAt: { gte: sevenDaysAgo },
      },
      orderBy: { capturedAt: 'desc' },
    });
    if (!row) return null;
    return {
      chain: row.chainJson as unknown as OptionsChainEntry[],
      capturedAt: row.capturedAt,
      source: row.source,
      spotPrice: Number(row.spotPrice),
    };
  }

  /**
   * Daily at 02:00 IST: prune snapshots older than 30 days. The 7-day read-
   * fallback window means anything older than a week is never read; we keep
   * an extra 23 days as a buffer for historical review / debugging.
   */
  @Cron('0 2 * * *', { timeZone: 'Asia/Kolkata' })
  async cleanupOldSnapshots(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.optionChainSnapshot.deleteMany({
        where: { capturedAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(`Pruned ${count} option-chain snapshots older than 30 days`);
      }
    } catch (error) {
      this.logger.warn(
        `Snapshot cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * NSE gives us real OI/volume/IV/LTP but no Greeks. Compute delta/gamma/
   * theta/vega from Black-Scholes using the NSE-provided IV so the frontend
   * keeps rendering a full chain without a second data source.
   */
  private enrichGreeks(
    chain: OptionsChainEntry[],
    spotPrice: number,
    expiry: string,
  ): OptionsChainEntry[] {
    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(15, 30, 0, 0);
    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

    for (const entry of chain) {
      if (entry.ceData) {
        const iv = (entry.ceData.iv || 15) / 100;
        const greeks = this.greeksCalculator.calculateGreeks(
          spotPrice, entry.strikePrice, timeToExpiry, DEFAULT_RISK_FREE_RATE, iv, 'CE',
        );
        entry.ceData.delta = greeks.delta;
        entry.ceData.gamma = greeks.gamma;
        entry.ceData.theta = greeks.theta;
        entry.ceData.vega = greeks.vega;
      }
      if (entry.peData) {
        const iv = (entry.peData.iv || 15) / 100;
        const greeks = this.greeksCalculator.calculateGreeks(
          spotPrice, entry.strikePrice, timeToExpiry, DEFAULT_RISK_FREE_RATE, iv, 'PE',
        );
        entry.peData.delta = greeks.delta;
        entry.peData.gamma = greeks.gamma;
        entry.peData.theta = greeks.theta;
        entry.peData.vega = greeks.vega;
      }
    }
    return chain;
  }

  /**
   * Calculate max pain strike -- the strike where total loss for option writers is minimized.
   *
   * `metric` selects which weighting to use: 'oi' (canonical) or 'volume'
   * (fallback when OI is unavailable from the data source). Volume-derived
   * "max pain" isn't classic max-pain — it's "the strike where today's
   * traded flow would expire most flat" — but it's the right shape and
   * better than returning 0.
   */
  getMaxPain(
    chain: OptionsChainEntry[],
    metric: 'oi' | 'volume' = 'oi',
  ): number {
    if (chain.length === 0) return 0;

    const strikes = chain.map((e) => e.strikePrice);
    let minPain = Infinity;
    let maxPainStrike = 0;

    for (const testStrike of strikes) {
      let totalPain = 0;

      for (const entry of chain) {
        const ceWeight =
          metric === 'oi' ? (entry.ceData?.oi ?? 0) : (entry.ceData?.volume ?? 0);
        const peWeight =
          metric === 'oi' ? (entry.peData?.oi ?? 0) : (entry.peData?.volume ?? 0);
        // CE writers' loss if expiry at testStrike
        if (entry.ceData && testStrike > entry.strikePrice) {
          totalPain += (testStrike - entry.strikePrice) * ceWeight;
        }
        // PE writers' loss if expiry at testStrike
        if (entry.peData && testStrike < entry.strikePrice) {
          totalPain += (entry.strikePrice - testStrike) * peWeight;
        }
      }

      // Only consider strikes where there was actual pain (otherwise the
      // first strike trivially "wins" with totalPain=0 when all weights are
      // zero — that's the misleading "max pain at the lowest strike" bug).
      if (totalPain > 0 && totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = testStrike;
      }
    }

    return maxPainStrike;
  }

  /**
   * Calculate Put/Call ratio based on OI.
   */
  getPCR(chain: OptionsChainEntry[]): number {
    let totalCEOI = 0;
    let totalPEOI = 0;

    for (const entry of chain) {
      if (entry.ceData) totalCEOI += entry.ceData.oi;
      if (entry.peData) totalPEOI += entry.peData.oi;
    }

    if (totalCEOI === 0) return 0;
    return Math.round((totalPEOI / totalCEOI) * 100) / 100;
  }

  /**
   * Get full OI analysis summary.
   *
   * When OI is genuinely unavailable (Angel One's optionGreek API doesn't
   * return OI without the paid Market Data subscription) we fall back to
   * volume-based analytics. Volume tells a similar story for an intraday
   * view: where the day's flow is concentrated → likely intraday support
   * and resistance. The frontend renders these under "Volume Analysis"
   * labels so the trader knows what they're looking at.
   */
  getOISummary(chain: OptionsChainEntry[]): OISummary {
    let totalCEOI = 0;
    let totalPEOI = 0;
    let highestCEOI = 0;
    let highestPEOI = 0;
    let highestCEOIStrike = 0;
    let highestPEOIStrike = 0;

    let totalCEVolume = 0;
    let totalPEVolume = 0;
    let highestCEVolume = 0;
    let highestPEVolume = 0;
    let highestCEVolumeStrike = 0;
    let highestPEVolumeStrike = 0;

    for (const entry of chain) {
      if (entry.ceData) {
        totalCEOI += entry.ceData.oi;
        totalCEVolume += entry.ceData.volume;
        if (entry.ceData.oi > highestCEOI) {
          highestCEOI = entry.ceData.oi;
          highestCEOIStrike = entry.strikePrice;
        }
        if (entry.ceData.volume > highestCEVolume) {
          highestCEVolume = entry.ceData.volume;
          highestCEVolumeStrike = entry.strikePrice;
        }
      }
      if (entry.peData) {
        totalPEOI += entry.peData.oi;
        totalPEVolume += entry.peData.volume;
        if (entry.peData.oi > highestPEOI) {
          highestPEOI = entry.peData.oi;
          highestPEOIStrike = entry.strikePrice;
        }
        if (entry.peData.volume > highestPEVolume) {
          highestPEVolume = entry.peData.volume;
          highestPEVolumeStrike = entry.strikePrice;
        }
      }
    }

    const oiAvailable = totalCEOI > 0 || totalPEOI > 0;
    const totalCE = oiAvailable ? totalCEOI : totalCEVolume;
    const totalPE = oiAvailable ? totalPEOI : totalPEVolume;
    const highestCEStrike = oiAvailable ? highestCEOIStrike : highestCEVolumeStrike;
    const highestPEStrike = oiAvailable ? highestPEOIStrike : highestPEVolumeStrike;

    const pcr =
      totalCE === 0 ? 0 : Math.round((totalPE / totalCE) * 100) / 100;
    const maxPainStrike = this.getMaxPain(chain, oiAvailable ? 'oi' : 'volume');

    return {
      totalCEOI: totalCE,
      totalPEOI: totalPE,
      pcr,
      maxPainStrike,
      highestCEOIStrike: highestCEStrike,
      highestPEOIStrike: highestPEStrike,
    };
  }

  // ─────────────────────────────────────────────────────
  // Private: DB-backed methods (original approach)
  // ─────────────────────────────────────────────────────

  private async getExpiriesFromSnapshots(underlying: string): Promise<string[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const todayUtcMidnight = new Date();
    todayUtcMidnight.setUTCHours(0, 0, 0, 0);

    const rows = await this.prisma.optionChainSnapshot.findMany({
      where: {
        underlying: underlying.toUpperCase(),
        capturedAt: { gte: sevenDaysAgo },
        expiryDate: { gte: todayUtcMidnight },
      },
      select: { expiryDate: true },
      distinct: ['expiryDate'],
      orderBy: { expiryDate: 'asc' },
    });

    // expiryDate is @db.Date (no TZ), so its UTC midnight maps 1:1 to the
    // ISO "YYYY-MM-DD" we stored it with — no locale math needed.
    return rows.map((r) => r.expiryDate.toISOString().split('T')[0]);
  }

  private async getExpiriesFromDB(underlying: string): Promise<string[]> {
    try {
      const instruments = await this.prisma.instrument.findMany({
        where: {
          symbol: { contains: underlying, mode: 'insensitive' },
          segment: 'OPTIONS',
          isActive: true,
          expiry: { not: null },
        },
        select: { expiry: true },
        distinct: ['expiry'],
        orderBy: { expiry: 'asc' },
      });

      return instruments
        .filter((i) => i.expiry !== null && i.expiry >= new Date())
        .map((i) => i.expiry!.toISOString().split('T')[0]);
    } catch {
      return [];
    }
  }

  private async getChainFromDB(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    const expiryStart = new Date(expiry);
    expiryStart.setHours(0, 0, 0, 0);
    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(23, 59, 59, 999);

    // Filter by `name` exactly, NOT `symbol contains underlying` — the
    // `contains` form is a substring match, so a query for "NIFTY" would
    // also match every "BANKNIFTY*" symbol and bleed BANKNIFTY contracts
    // into NIFTY's chain. The instruments table has a dedicated `name`
    // column ("NIFTY" or "BANKNIFTY" verbatim) precisely so consumers
    // don't have to do this fragile prefix-matching on `symbol`.
    const instruments = await this.prisma.instrument.findMany({
      where: {
        name: { equals: underlying.toUpperCase(), mode: 'insensitive' },
        segment: 'OPTIONS',
        isActive: true,
        expiry: {
          gte: expiryStart,
          lte: expiryEnd,
        },
        strike: { not: null },
        optionType: { not: null },
      },
      orderBy: { strike: 'asc' },
    });

    if (instruments.length === 0) {
      return [];
    }

    // Group instruments by strike price
    const strikeMap = new Map<
      number,
      {
        ce: (typeof instruments)[0] | null;
        pe: (typeof instruments)[0] | null;
      }
    >();

    for (const inst of instruments) {
      const strike = inst.strike!;
      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { ce: null, pe: null });
      }
      const entry = strikeMap.get(strike)!;
      if (inst.optionType === OptionType.CE) {
        entry.ce = inst;
      } else if (inst.optionType === OptionType.PE) {
        entry.pe = inst;
      }
    }

    // Get spot price
    let spotPrice = 0;
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          underlying,
          'NSE',
        );
        spotPrice = quote.ltp;
      } catch {
        this.logger.warn(
          `Could not get live spot price for ${underlying}, using 0`,
        );
      }
    }

    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

    // Build chain entries
    const chain: OptionsChainEntry[] = [];
    for (const [strike, { ce, pe }] of strikeMap) {
      const ceData = ce
        ? await this.buildOptionDataFromDB(
            ce,
            spotPrice,
            strike,
            timeToExpiry,
            'CE',
          )
        : null;
      const peData = pe
        ? await this.buildOptionDataFromDB(
            pe,
            spotPrice,
            strike,
            timeToExpiry,
            'PE',
          )
        : null;

      chain.push({ strikePrice: strike, expiryDate: expiry, ceData, peData });
    }

    chain.sort((a, b) => a.strikePrice - b.strikePrice);
    return chain;
  }

  // ─────────────────────────────────────────────────────
  // Private: Angel One master-backed methods (dynamic)
  // ─────────────────────────────────────────────────────

  /**
   * Get option contracts from the Angel One instrument master,
   * using in-memory cache with TTL.
   */
  private async getOptionContracts(
    underlying: string,
  ): Promise<OptionContract[]> {
    // Prefix the cache key with exchange to keep NFO and MCX entries from
    // colliding. In practice CRUDEOIL/COPPER never appear in NFO, but being
    // explicit means we won't silently serve NFO rows for an MCX ask if the
    // symbol names ever overlap.
    const exchangePrefix = this.isMcxUnderlying(underlying) ? 'MCX' : 'NFO';
    const key = `${exchangePrefix}:${underlying.toUpperCase()}`;
    const cached = this.contractsCache.get(key);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.contracts;
    }

    if (!this.brokerAdapter || !this.brokerAdapter.getOptionContracts) {
      this.logger.warn(
        'Broker adapter unavailable or does not support getOptionContracts',
      );
      return [];
    }

    try {
      const contracts =
        await this.brokerAdapter.getOptionContracts(underlying);

      this.contractsCache.set(key, {
        contracts,
        fetchedAt: Date.now(),
      });

      return contracts;
    } catch (error) {
      this.logger.error(
        `Failed to fetch option contracts for ${underlying}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return [];
    }
  }

  /**
   * Build the options chain using Angel One's optionGreek API.
   * This returns the full chain with LTP, OI, Greeks in a single API call.
   */
  private async getChainFromMaster(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    if (!this.brokerAdapter) {
      this.logger.warn('No broker adapter — cannot build options chain');
      return [];
    }

    // Get spot price
    const indexTokens: Record<string, { token: string; exchange: string }> = {
      NIFTY: { token: '99926000', exchange: 'NSE' },
      BANKNIFTY: { token: '99926009', exchange: 'NSE' },
      FINNIFTY: { token: '99926037', exchange: 'NSE' },
      MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
    };

    let spotPrice = 0;
    const indexInfo = indexTokens[underlying.toUpperCase()];
    if (indexInfo) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(indexInfo.token, indexInfo.exchange);
        spotPrice = quote.ltp;
      } catch {
        this.logger.warn(`Could not get spot price for ${underlying}`);
      }
    }

    // Format expiry as DDMMMYYYY for Angel One API (e.g., "03APR2026")
    const expiryDate = new Date(expiry);
    const day = String(expiryDate.getDate()).padStart(2, '0');
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const mon = months[expiryDate.getMonth()];
    const year = expiryDate.getFullYear();
    const expiryTag = `${day}${mon}${year}`;

    this.logger.log(
      `Fetching option chain via optionGreek API: ${underlying} ${expiryTag}`,
    );

    try {
      // Use Angel One's optionGreek API — returns full chain in one call
      if (!this.authService.isAuthenticated()) {
        this.logger.warn('AngelOneAuthService not available or not authenticated — cannot call optionGreek');
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }
      const smartApi = this.authService.getSmartApi();
      if (!smartApi?.optionGreek) {
        this.logger.warn('optionGreek API not available on SmartAPI instance');
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }

      const response = await smartApi.optionGreek({
        name: underlying.toUpperCase(),
        expirydate: expiryTag,
      });

      this.logger.debug(`optionGreek raw response status: ${response?.status}, message: ${response?.message}`);

      // Angel One may return data directly or nested under response.data
      const rawData = response?.data;
      if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
        this.logger.warn(
          `optionGreek returned no data for ${underlying} ${expiryTag}. ` +
          `Response: ${JSON.stringify({ status: response?.status, message: response?.message, dataType: typeof rawData, dataIsArray: Array.isArray(rawData) })}`,
        );
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }

      // Log first contract keys for debugging field names
      this.logger.debug(`optionGreek sample contract keys: ${Object.keys(rawData[0]).join(', ')}`);
      this.logger.log(`optionGreek returned ${rawData.length} contracts`);

      // Group by strike price
      const strikeMap = new Map<number, { ce: any; pe: any }>();

      for (const contract of rawData) {
        const strike = Number(
          contract.strikePrice ?? contract.strikeprice ?? contract.strike_price ?? 0,
        );
        if (strike <= 0) continue;

        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, { ce: null, pe: null });
        }
        const entry = strikeMap.get(strike)!;
        const optType = (
          contract.optionType ?? contract.option_type ?? contract.opttype ?? ''
        ).toUpperCase();
        if (optType === 'CE') entry.ce = contract;
        else if (optType === 'PE') entry.pe = contract;
      }

      const expiryEnd = new Date(expiry);
      expiryEnd.setHours(15, 30, 0, 0);
      const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

      // Build chain entries
      const chain: OptionsChainEntry[] = [];
      for (const [strike, { ce, pe }] of strikeMap) {
        chain.push({
          strikePrice: strike,
          expiryDate: expiry,
          ceData: ce ? this.mapOptionGreekData(ce, spotPrice, strike, timeToExpiry, 'CE') : null,
          peData: pe ? this.mapOptionGreekData(pe, spotPrice, strike, timeToExpiry, 'PE') : null,
        });
      }

      chain.sort((a, b) => a.strikePrice - b.strikePrice);

      // Limit to ±20 strikes around ATM
      if (spotPrice > 0 && chain.length > 40) {
        let atmIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < chain.length; i++) {
          const diff = Math.abs(chain[i].strikePrice - spotPrice);
          if (diff < minDiff) { minDiff = diff; atmIdx = i; }
        }
        const start = Math.max(0, atmIdx - 20);
        const end = Math.min(chain.length, atmIdx + 21);
        const trimmed = chain.slice(start, end);
        this.logger.log(`Options chain: ${trimmed.length} strikes around ATM ${spotPrice}`);
        return trimmed;
      }

      this.logger.log(`Options chain: ${chain.length} strikes, spot=${spotPrice}`);
      return chain;
    } catch (error) {
      this.logger.warn(
        `optionGreek API failed: ${error instanceof Error ? error.message : error}. Using synthetic chain.`,
      );
      return this.buildSyntheticChain(underlying, expiry, spotPrice);
    }
  }

  /**
   * Map a single contract from optionGreek API response to our OptionData format.
   *
   * Field names actually returned by Angel One's optionGreek payload (per
   * runtime sampling): name, expiry, strikePrice, optionType, delta, gamma,
   * theta, vega, impliedVolatility, tradeVolume. NOTE the absences:
   *   - no ltp / lastPrice    → we compute theoretical LTP from BS below
   *   - no openInterest / oi  → optionGreek genuinely does not return OI;
   *                             that's a separate paid Angel One product.
   *                             Leave oi=0 and surface the gap to the user
   *                             rather than fake it.
   *   - volume key is `tradeVolume`, not `totalTradedVolume` — the older
   *     fallback chain was missing this and silently zeroing volume.
   */
  private mapOptionGreekData(
    contract: any,
    spotPrice: number,
    strike: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): OptionData {
    const ltpRaw = Number(contract.ltp ?? contract.lastPrice ?? 0);
    const oi = Number(contract.openInterest ?? contract.opnInterest ?? contract.oi ?? 0);
    const oiChange = Number(contract.oiChange ?? contract.changeinOpenInterest ?? 0);
    // `tradeVolume` is the optionGreek-native key; the older variants are
    // kept for forward-compat in case Angel One ever renames.
    const volume = Number(
      contract.tradeVolume ?? contract.totalTradedVolume ?? contract.volume ?? 0,
    );
    // optionGreek returns IV as a percentage (e.g. 33.36), not a decimal.
    // Greeks calculator expects decimal (0.3336) for theoretical-price math.
    const ivPercent = Number(contract.impliedVolatility ?? contract.iv ?? 0);
    const ivDecimal = ivPercent > 1 ? ivPercent / 100 : ivPercent;
    const delta = Number(contract.delta ?? 0);
    const gamma = Number(contract.gamma ?? 0);
    const theta = Number(contract.theta ?? 0);
    const vega = Number(contract.vega ?? 0);
    const bidPrice = Number(contract.bidprice ?? contract.bidPrice ?? 0);
    const askPrice = Number(contract.askprice ?? contract.askPrice ?? 0);

    // If we have Greeks but no LTP (the common optionGreek case), compute a
    // theoretical LTP from Black-Scholes using the broker's IV. This gives
    // the user a usable price column even when Angel One's quote API can't
    // be hit (entitlement limits / 403s on indices). Mid-of-bid-ask is
    // preferred when available.
    let ltp = ltpRaw;
    if (ltp <= 0 && bidPrice > 0 && askPrice > 0) {
      ltp = (bidPrice + askPrice) / 2;
    }
    if (ltp <= 0 && ivDecimal > 0 && spotPrice > 0 && timeToExpiry > 0) {
      ltp = this.greeksCalculator.blackScholesPrice(
        spotPrice,
        strike,
        timeToExpiry,
        DEFAULT_RISK_FREE_RATE,
        ivDecimal,
        optionType,
      );
    }

    // If optionGreek provides Greeks directly, use them — otherwise compute.
    if (ivPercent > 0 || delta !== 0) {
      return {
        ltp,
        oi,
        oiChange,
        volume,
        iv: ivPercent,
        delta,
        gamma,
        theta,
        vega,
        bidPrice,
        askPrice,
      };
    }

    return this.computeGreeksAndIV(
      ltp, oi, oiChange, volume, bidPrice, askPrice,
      spotPrice, strike, timeToExpiry, optionType,
    );
  }

  /**
   * Build a synthetic chain with theoretical values when live data is unavailable.
   * Uses Black-Scholes to compute approximate option prices.
   */
  private buildSyntheticChain(
    underlying: string,
    expiry: string,
    spotPrice: number,
  ): OptionsChainEntry[] {
    if (spotPrice === 0) return [];

    const strikeIntervals: Record<string, number> = {
      NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
    };
    const interval = strikeIntervals[underlying.toUpperCase()] ?? 50;
    const atmStrike = Math.round(spotPrice / interval) * interval;

    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(15, 30, 0, 0);
    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);
    const defaultIV = 0.15; // 15% assumed IV

    const chain: OptionsChainEntry[] = [];
    for (let i = -10; i <= 10; i++) {
      const strike = atmStrike + i * interval;
      const ceGreeks = this.greeksCalculator.calculateGreeks(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'CE',
      );
      const peGreeks = this.greeksCalculator.calculateGreeks(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'PE',
      );
      const cePrice = this.greeksCalculator.blackScholesPrice(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'CE',
      );
      const pePrice = this.greeksCalculator.blackScholesPrice(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'PE',
      );

      chain.push({
        strikePrice: strike,
        expiryDate: expiry,
        ceData: {
          ltp: Math.round(cePrice * 100) / 100,
          oi: 0, oiChange: 0, volume: 0,
          iv: defaultIV * 100,
          ...ceGreeks,
          bidPrice: 0, askPrice: 0,
        },
        peData: {
          ltp: Math.round(pePrice * 100) / 100,
          oi: 0, oiChange: 0, volume: 0,
          iv: defaultIV * 100,
          ...peGreeks,
          bidPrice: 0, askPrice: 0,
        },
      });
    }

    this.logger.log(`Built synthetic chain: ${chain.length} strikes, spot=${spotPrice}`);
    return chain;
  }

  // ─────────────────────────────────────────────────────
  // Private: Build OptionData for a single contract
  // ─────────────────────────────────────────────────────

  /**
   * Build OptionData from a DB instrument record.
   */
  private async buildOptionDataFromDB(
    instrument: {
      token: string;
      symbol: string;
      exchange: string;
    },
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): Promise<OptionData> {
    let ltp = 0;
    let oi = 0;
    let oiChange = 0;
    let volume = 0;
    const bidPrice = 0;
    const askPrice = 0;

    // Try to get live data from broker
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          instrument.token,
          instrument.exchange,
        );
        ltp = quote.ltp;
        volume = quote.volume;
      } catch {
        // Use defaults
      }
    }

    // Get latest OI from database
    try {
      const latestOI = await this.prisma.oISnapshot.findFirst({
        where: {
          instrument: { token: instrument.token },
        },
        orderBy: { timestamp: 'desc' },
      });

      if (latestOI) {
        oi = Number(latestOI.oi);
        oiChange = Number(latestOI.oiChange);
      }
    } catch {
      // Use defaults
    }

    return this.computeGreeksAndIV(
      ltp,
      oi,
      oiChange,
      volume,
      bidPrice,
      askPrice,
      spotPrice,
      strikePrice,
      timeToExpiry,
      optionType,
    );
  }

  /**
   * Build OptionData from an Angel One master contract (dynamic discovery).
   */
  private async buildOptionDataFromMaster(
    contract: OptionContract,
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): Promise<OptionData> {
    let ltp = 0;
    let oi = 0;
    let oiChange = 0;
    let volume = 0;
    const bidPrice = 0;
    const askPrice = 0;

    // Fetch live quote from Angel One using the contract token
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          contract.token,
          contract.exchange,
        );
        ltp = quote.ltp;
        volume = quote.volume;
        // Angel One FULL mode returns OI in the response
        if ((quote as any).oi != null) {
          oi = Number((quote as any).oi);
        }
      } catch (err) {
        this.logger.debug(
          `Could not get live quote for ${contract.symbol}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    return this.computeGreeksAndIV(
      ltp,
      oi,
      oiChange,
      volume,
      bidPrice,
      askPrice,
      spotPrice,
      strikePrice,
      timeToExpiry,
      optionType,
    );
  }

  /**
   * Shared helper: compute IV and Greeks from raw market data.
   */
  private computeGreeksAndIV(
    ltp: number,
    oi: number,
    oiChange: number,
    volume: number,
    bidPrice: number,
    askPrice: number,
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): OptionData {
    // Calculate IV from the market price
    let iv = 0;
    if (ltp > 0 && spotPrice > 0 && timeToExpiry > 0) {
      iv = this.greeksCalculator.calculateIV(
        ltp,
        spotPrice,
        strikePrice,
        timeToExpiry,
        DEFAULT_RISK_FREE_RATE,
        optionType,
      );
    }

    // Calculate Greeks
    const greeks =
      iv > 0 && spotPrice > 0 && timeToExpiry > 0
        ? this.greeksCalculator.calculateGreeks(
            spotPrice,
            strikePrice,
            timeToExpiry,
            DEFAULT_RISK_FREE_RATE,
            iv,
            optionType,
          )
        : { delta: 0, gamma: 0, theta: 0, vega: 0 };

    return {
      ltp,
      oi,
      oiChange,
      volume,
      iv: Math.round(iv * 10000) / 100, // Convert to percentage
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      bidPrice,
      askPrice,
    };
  }
}
