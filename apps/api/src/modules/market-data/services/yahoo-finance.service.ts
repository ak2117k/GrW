import { Injectable, Logger } from '@nestjs/common';

/**
 * Yahoo Finance symbol mapping for Indian market instruments.
 * Index tokens → Yahoo symbols, stock symbols → Yahoo format.
 */
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  // Indices (by token)
  '99926000': '^NSEI',       // NIFTY 50
  '99926009': '^NSEBANK',    // BANK NIFTY
  '99926037': 'NIFTY_FIN_SERVICE.NS', // FIN NIFTY
  '99919000': '^BSESN',     // SENSEX
  '99926025': '^NSEMDCP50',  // NIFTY MIDCAP 50
  '99926013': '^CNXIT',      // NIFTY IT
};

/** Convert an Angel One stock symbol to Yahoo Finance format. */
function toYahooSymbol(symbol: string, exchange: string, token: string): string | null {
  // Check token-based mapping first (for indices)
  if (YAHOO_SYMBOL_MAP[token]) {
    return YAHOO_SYMBOL_MAP[token];
  }

  // NSE stocks: append .NS
  if (exchange === 'NSE' || exchange === 'NFO') {
    return `${symbol}.NS`;
  }

  // BSE stocks: append .BO
  if (exchange === 'BSE') {
    return `${symbol}.BO`;
  }

  // MCX commodities — Yahoo doesn't have good MCX data
  return null;
}

/** Map our timeframe codes to Yahoo Finance intervals. */
const YAHOO_INTERVAL_MAP: Record<string, string> = {
  '1d': '1d',
  '1w': '1wk',
  '1M': '1mo',
};

/** Map our timeframe to a sensible Yahoo range. */
const YAHOO_RANGE_MAP: Record<string, string> = {
  '1d': '1y',
  '1w': '2y',
  '1M': '5y',
};

interface YahooCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooDailyChange {
  symbol: string;
  last: number;
  previousClose: number;
  change: number;
  changePercent: number;
  /** Yahoo's own `regularMarketTime` as ISO, or null when it gave none. */
  quoteTime: string | null;
}

/**
 * The last close (or live price) vs the daily close before it, from a v8 chart
 * payload with `interval=1d`. Pure; the market-cues fetcher parses the same
 * payload with it. Null when either value is missing — never a 0 change.
 */
export function parseYahooDailyChange(data: any, fallbackSymbol = ''): YahooDailyChange | null {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  if (!meta || !Array.isArray(closes) || closes.length < 2) return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const lastBar = closes[closes.length - 1];
  const last = ok(meta.regularMarketPrice) ? meta.regularMarketPrice : ok(lastBar) ? lastBar : null;
  const prev = closes[closes.length - 2];
  if (last === null || !ok(prev)) return null;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const t = Number(meta.regularMarketTime);
  return {
    symbol: String(meta.symbol ?? fallbackSymbol),
    last,
    previousClose: round2(prev),
    change: round2(last - prev),
    changePercent: round2(((last - prev) / prev) * 100),
    quoteTime: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : null,
  };
}

interface YahooQuoteData {
  previousClose: number;
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
}

@Injectable()
export class YahooFinanceService {
  private readonly logger = new Logger(YahooFinanceService.name);

  /**
   * Fetch historical candles from Yahoo Finance.
   * Supports 1d, 1wk, 1mo intervals natively — no aggregation needed.
   * Returns null if the symbol can't be mapped or the request fails.
   */
  async getCandles(
    symbol: string,
    exchange: string,
    token: string,
    timeframe: string,
    from?: Date,
    to?: Date,
  ): Promise<YahooCandle[] | null> {
    const yahooSymbol = toYahooSymbol(symbol, exchange, token);
    if (!yahooSymbol) return null;

    const interval = YAHOO_INTERVAL_MAP[timeframe];
    if (!interval) return null; // Only handle daily, weekly, monthly

    try {
      let url: string;

      if (from && to) {
        // Use period1/period2 for custom date range
        const period1 = Math.floor(from.getTime() / 1000);
        const period2 = Math.floor(to.getTime() / 1000);
        url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&period1=${period1}&period2=${period2}`;
      } else {
        // Use range parameter
        const range = YAHOO_RANGE_MAP[timeframe] ?? '1y';
        url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
      }

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) {
        this.logger.warn(`Yahoo Finance returned ${response.status} for ${yahooSymbol}`);
        return null;
      }

      const data = await response.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp) return null;

      const timestamps: number[] = result.timestamp;
      const quote = result.indicators?.quote?.[0];
      if (!quote) return null;

      const candles: YahooCandle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = quote.open?.[i];
        const h = quote.high?.[i];
        const l = quote.low?.[i];
        const c = quote.close?.[i];
        const v = quote.volume?.[i] ?? 0;

        // Skip null candles (holidays/missing data)
        if (o == null || h == null || l == null || c == null) continue;

        candles.push({
          timestamp: new Date(timestamps[i] * 1000),
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v,
        });
      }

      this.logger.debug(
        `Yahoo Finance: ${yahooSymbol} ${interval} → ${candles.length} candles`,
      );

      return candles;
    } catch (error) {
      this.logger.warn(
        `Yahoo Finance fetch failed for ${yahooSymbol}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * Get the previous close and ONE-DAY change from Yahoo Finance: the last
   * close (or live price) against the daily close before it. Not
   * `chartPreviousClose` — with `range=5d` that is the close before the
   * five-day range, which made this a ~5-day change. Null, never a 0 change,
   * when there is no prior close.
   */
  async getQuoteChange(
    symbol: string,
    exchange: string,
    token: string,
  ): Promise<YahooQuoteData | null> {
    const yahooSymbol = toYahooSymbol(symbol, exchange, token);
    if (!yahooSymbol) return null;

    const d = await this.getDailyChangeBySymbol(yahooSymbol);
    if (!d) return null;
    return {
      previousClose: d.previousClose,
      regularMarketPrice: d.last,
      regularMarketChange: d.change,
      regularMarketChangePercent: d.changePercent,
    };
  }

  /**
   * One-day change for a Yahoo symbol given directly (`^IXIC`, `NQ=F`) — for
   * instruments with no Angel token, so no mapping is needed. Null on any
   * failure, or when either close is missing.
   */
  async getDailyChangeBySymbol(yahooSymbol: string): Promise<YahooDailyChange | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return parseYahooDailyChange(await response.json(), yahooSymbol);
    } catch {
      return null;
    }
  }

  /**
   * Check if a given timeframe is supported by Yahoo Finance directly.
   */
  isSupported(timeframe: string): boolean {
    return timeframe in YAHOO_INTERVAL_MAP;
  }

  /**
   * Check if a symbol can be resolved to a Yahoo symbol.
   */
  canResolve(symbol: string, exchange: string, token: string): boolean {
    return toYahooSymbol(symbol, exchange, token) !== null;
  }

  /**
   * Fetch Yahoo Finance's assetProfile + summaryProfile modules for an NSE stock.
   * Returns sector + industry classification. Used by NseSectorIndexService as
   * a Tier-3 fallback for stocks NSE doesn't publish in any sector index.
   *
   * No auth required. Light rate limits — caller MUST cache aggressively
   * (sector/industry don't change intraday).
   *
   * Returns null if Yahoo doesn't have the symbol or the API call fails.
   */
  async getAssetProfile(symbol: string): Promise<{ sector: string | null; industry: string | null } | null> {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}.NS?modules=assetProfile,summaryProfile`;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        this.logger.warn(`Yahoo getAssetProfile(${symbol}) returned ${response.status}`);
        return null;
      }
      const data = (await response.json()) as any;
      const result = data?.quoteSummary?.result?.[0];
      if (!result) return null;
      const profile = result.assetProfile ?? result.summaryProfile;
      if (!profile) return null;
      return {
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Yahoo getAssetProfile(${symbol}) failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Fetch India VIX spot price from Yahoo Finance (^INDIAVIX).
   *
   * Used by MarketContextService to stamp the volatility regime onto every
   * trade entry. Returns null on failure so callers can keep the trade
   * record (with vix=null) — partial context is more useful than no trade.
   */
  async getIndiaVix(): Promise<number | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('^INDIAVIX')}?interval=1d&range=5d`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) {
        this.logger.warn(`Yahoo Finance returned ${response.status} for ^INDIAVIX`);
        return null;
      }

      const data = (await response.json()) as any;
      const meta = data?.chart?.result?.[0]?.meta;
      const ltp = meta?.regularMarketPrice;
      if (typeof ltp !== 'number' || !Number.isFinite(ltp)) {
        return null;
      }
      return ltp;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch India VIX: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }
}
