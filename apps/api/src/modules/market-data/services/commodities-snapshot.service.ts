import { Injectable, Logger } from '@nestjs/common';
import { CommodityRollService } from './commodity-roll.service';
import { MarketQuoteResolver } from './market-quote-resolver.service';
import type { QuoteRequestRef } from './market-quote-resolver.service';

/**
 * One row of `GET /api/market-data/commodities`.
 *
 * The shape is a hard contract with `apps/web/src/hooks/useCommodities.ts` —
 * notably `ltp: number | null`, where `null` means "this commodity could not be
 * quoted" and the frontend SKIPS the row rather than rendering a 0 price. Do
 * not collapse it to 0.
 */
export interface CommoditySnapshotRow {
  symbol: string;
  token: string;
  exchange: string;
  contractSymbol: string;
  expiry: string;
  ltp: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

export interface CommoditiesSnapshot {
  commodities: CommoditySnapshotRow[];
  count: number;
}

/** Broker/fallback numbers can be NaN/Infinity/undefined; the client calls
 *  toFixed() on all of them, so coerce anything non-finite to 0. */
function finite(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Match the 2-dp rounding the endpoint has always returned for change fields. */
function round2(value: number): number {
  return Number(finite(value).toFixed(2));
}

/**
 * Live commodity snapshot, fetched over the REQUEST USER'S OWN Angel session.
 *
 * Two independent halves:
 *
 *  1. `CommodityRollService.resolveFrontMonthTokens()` — resolves each tracked
 *     commodity's current front-month token from Angel's PUBLIC ScripMaster.
 *     Needs no auth, is cached ~6h, and self-heals across monthly contract
 *     rollovers because the front month is always re-resolved.
 *
 *  2. `MarketQuoteResolver.resolveQuotes(userId, …)` — batched FULL-mode quotes
 *     over the user's own broker session, with a daily-candle fallback. This
 *     replaces the old `AngelOneAdapter.getQuotesBatch()` path, which went
 *     through the SHARED feed account that no longer exists (every quote came
 *     back empty, so every `ltp` was null and the Commodities tab was blank).
 *
 * A commodity the resolver cannot price by either path is ABSENT from the
 * returned map; its row is still emitted, with `ltp: null` and zeroed OHLCV, so
 * the caller can see which contracts exist but aren't quotable (e.g. the user's
 * account has no MCX segment entitlement).
 */
@Injectable()
export class CommoditiesSnapshotService {
  private readonly logger = new Logger(CommoditiesSnapshotService.name);

  constructor(
    private readonly commodityRollService: CommodityRollService,
    private readonly quoteResolver: MarketQuoteResolver,
  ) {}

  /**
   * @param userId — the requesting user, whose own Angel session is used for
   *                 quoting. Contract resolution is user-independent.
   */
  async getSnapshot(userId: string): Promise<CommoditiesSnapshot> {
    const contracts = await this.commodityRollService.resolveFrontMonthTokens();

    if (contracts.length === 0) {
      this.logger.warn('getSnapshot: no front-month contracts resolved (ScripMaster unavailable?)');
      return { commodities: [], count: 0 };
    }

    const refs: QuoteRequestRef[] = contracts.map((c) => ({
      token: c.token,
      exchange: c.exchange || 'MCX',
      symbol: c.symbol,
    }));

    const quotes = await this.quoteResolver.resolveQuotes(userId, refs);

    const commodities: CommoditySnapshotRow[] = contracts.map((c) => {
      const q = quotes.get(c.token);
      return {
        symbol: c.symbol,
        token: c.token,
        exchange: c.exchange,
        contractSymbol: c.contractSymbol,
        expiry: c.expiry,
        // null (not 0) is meaningful: the frontend skips unquotable rows.
        ltp: q ? finite(q.ltp) : null,
        open: finite(q?.open),
        high: finite(q?.high),
        low: finite(q?.low),
        close: finite(q?.close),
        volume: finite(q?.volume),
        // The resolver already derives these from the previous close.
        change: q ? round2(q.change) : 0,
        changePercent: q ? round2(q.changePercent) : 0,
      };
    });

    const quoted = commodities.filter((c) => c.ltp != null).length;
    this.logger.log(`getSnapshot: quoted ${quoted}/${commodities.length} commodities`);

    return { commodities, count: commodities.length };
  }
}
