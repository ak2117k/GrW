import { Injectable, Logger } from '@nestjs/common';
import { OptionsChainEntry } from '@td/shared/types';

/**
 * NSE India publishes a public options-chain endpoint that returns the full
 * chain for an index (NIFTY, BANKNIFTY, FINNIFTY) in a single call, including
 * real open interest, OI change, volume, IV, and LTP — data our existing
 * Angel One `optionGreek` path doesn't reliably deliver.
 *
 * The endpoint requires cookies from a prior visit to the NSE homepage — a
 * clean curl returns 401. We warm the cookie jar once per session and
 * transparently refresh it if a request 401s.
 *
 * Cached per (symbol) for 30 s to avoid hammering NSE and tripping their
 * rate-limit / bot-detection heuristics.
 */

interface NseOptionLeg {
  strikePrice: number;
  expiryDate: string;
  openInterest?: number;
  changeinOpenInterest?: number;
  totalTradedVolume?: number;
  impliedVolatility?: number;
  lastPrice?: number;
  bidprice?: number;
  askPrice?: number;
}

interface NseChainRow {
  strikePrice: number;
  expiryDate: string;
  CE?: NseOptionLeg;
  PE?: NseOptionLeg;
}

interface NseChainResponse {
  records?: {
    expiryDates?: string[];
    data?: NseChainRow[];
    underlyingValue?: number;
  };
}

interface CacheEntry {
  data: NseChainResponse;
  fetchedAt: number;
}

const NSE_HOME = 'https://www.nseindia.com';
const NSE_CHAIN_URL = 'https://www.nseindia.com/api/option-chain-indices';
const CACHE_TTL_MS = 30_000;
const COOKIE_TTL_MS = 10 * 60 * 1000;

/** Supported NSE index symbols. */
const SUPPORTED_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);

/** Browser-like headers so NSE doesn't bounce us as a bot. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

@Injectable()
export class NseOptionsChainService {
  private readonly logger = new Logger(NseOptionsChainService.name);

  private cookieHeader: string | null = null;
  private cookieSetAt = 0;

  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Fetch the full NSE option chain for an index, filtered to a single
   * expiry, and mapped into our internal OptionsChainEntry shape.
   * Returns null when the symbol is unsupported, the network call fails,
   * or NSE returns malformed data — callers should fall back gracefully.
   */
  async getChain(
    underlying: string,
    expiry: string,
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number } | null> {
    const symbol = underlying.toUpperCase();
    if (!SUPPORTED_SYMBOLS.has(symbol)) {
      this.logger.debug(`NSE chain: ${symbol} not supported, skipping`);
      return null;
    }

    const raw = await this.fetchRawChain(symbol);
    if (!raw?.records?.data) return null;

    const spotPrice = Number(raw.records.underlyingValue ?? 0);
    const nseExpiry = this.toNseExpiry(expiry);

    // Filter to requested expiry; if no exact match, log available expiries
    const rows = raw.records.data.filter((r) => r.expiryDate === nseExpiry);
    if (rows.length === 0) {
      this.logger.warn(
        `NSE chain: no rows for expiry ${expiry} (mapped to ${nseExpiry}). ` +
          `Available: ${raw.records.expiryDates?.slice(0, 5).join(', ')}...`,
      );
      return null;
    }

    const chain: OptionsChainEntry[] = rows.map((r) => ({
      strikePrice: r.strikePrice,
      expiryDate: expiry,
      ceData: this.mapLeg(r.CE),
      peData: this.mapLeg(r.PE),
    }));

    chain.sort((a, b) => a.strikePrice - b.strikePrice);

    this.logger.log(
      `NSE chain: ${chain.length} strikes for ${symbol} ${expiry}, spot=${spotPrice}`,
    );
    return { chain, spotPrice };
  }

  private mapLeg(leg?: NseOptionLeg) {
    if (!leg) return null;
    return {
      ltp: Number(leg.lastPrice ?? 0),
      oi: Number(leg.openInterest ?? 0),
      oiChange: Number(leg.changeinOpenInterest ?? 0),
      volume: Number(leg.totalTradedVolume ?? 0),
      iv: Number(leg.impliedVolatility ?? 0),
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      bidPrice: Number(leg.bidprice ?? 0),
      askPrice: Number(leg.askPrice ?? 0),
    };
  }

  /**
   * Convert our ISO expiry (2026-04-12) to NSE's display format (12-Apr-2026).
   */
  private toNseExpiry(iso: string): string {
    const d = new Date(iso);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${day}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }

  private async fetchRawChain(symbol: string): Promise<NseChainResponse | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      await this.ensureCookies();
      const url = `${NSE_CHAIN_URL}?symbol=${encodeURIComponent(symbol)}`;
      this.logger.log(
        `NSE: fetching ${symbol} chain (cookies=${this.cookieHeader ? 'set' : 'empty'})`,
      );

      const apiHeaders = {
        ...BROWSER_HEADERS,
        'Accept': 'application/json, text/plain, */*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': this.cookieHeader ?? '',
        'Referer': `${NSE_HOME}/option-chain`,
      };

      let res = await fetch(url, { headers: apiHeaders });
      this.logger.log(`NSE: ${symbol} chain → HTTP ${res.status}`);

      // 401/403 → cookies expired. Refresh once and retry.
      if (res.status === 401 || res.status === 403) {
        this.logger.warn(`NSE ${res.status}, refreshing cookies and retrying`);
        this.cookieHeader = null;
        this.cookieSetAt = 0;
        await this.ensureCookies();
        res = await fetch(url, {
          headers: { ...apiHeaders, 'Cookie': this.cookieHeader ?? '' },
        });
      }

      if (!res.ok) {
        this.logger.warn(`NSE chain fetch failed: HTTP ${res.status}`);
        return null;
      }

      const text = await res.text();
      const data = (text ? JSON.parse(text) : {}) as NseChainResponse;
      if (!data?.records?.data) {
        this.logger.warn(
          `NSE ${symbol}: HTTP 200 but empty body (${text.length}B) — likely TLS-fingerprint block, ` +
            `won't retry this session`,
        );
        return null;
      }
      this.cache.set(symbol, { data, fetchedAt: Date.now() });
      return data;
    } catch (error) {
      this.logger.warn(
        `NSE chain fetch error: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * NSE blocks direct API requests without cookies. Visit the homepage to
   * collect the session cookies the browser would normally get.
   */
  private async ensureCookies(): Promise<void> {
    if (this.cookieHeader && Date.now() - this.cookieSetAt < COOKIE_TTL_MS) {
      return;
    }

    this.logger.log('NSE: warming cookie jar');
    const jar = new Map<string, string>();

    const collect = (res: Response) => {
      const lines: string[] = (res.headers as any).getSetCookie?.() ?? [];
      if (lines.length === 0) {
        const raw = res.headers.get('set-cookie');
        if (raw) lines.push(raw);
      }
      for (const line of lines) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          if (name && value) jar.set(name, value);
        }
      }
    };

    const jarToHeader = () =>
      Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

    // Step 1: homepage sets base cookies (nsit, bm_* bot-detection, etc).
    const home = await fetch(NSE_HOME, { headers: BROWSER_HEADERS });
    this.logger.log(`NSE: homepage → HTTP ${home.status}`);
    collect(home);
    await home.text();

    // Step 2: option-chain page sets the additional session cookies NSE ties
    // to the specific feature route. Without this step, the API endpoint
    // silently returns {} even with HTTP 200.
    const chainPage = await fetch(`${NSE_HOME}/option-chain`, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': `${NSE_HOME}/`,
        'Cookie': jarToHeader(),
      },
    });
    this.logger.log(`NSE: option-chain page → HTTP ${chainPage.status}`);
    collect(chainPage);
    await chainPage.text();

    // Step 3: hit the market-status API to bind the cookie jar to an
    // authenticated API session (NSE's bot-detection layer uses this).
    try {
      const mkt = await fetch(`${NSE_HOME}/api/marketStatus`, {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json, text/plain, */*',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${NSE_HOME}/option-chain`,
          'Cookie': jarToHeader(),
        },
      });
      this.logger.log(`NSE: marketStatus → HTTP ${mkt.status}`);
      collect(mkt);
      await mkt.text();
    } catch (err) {
      this.logger.warn(`NSE: marketStatus warmup failed: ${err instanceof Error ? err.message : err}`);
    }

    this.cookieHeader = jar.size > 0 ? jarToHeader() : null;
    this.cookieSetAt = Date.now();
    this.logger.log(`NSE: cookie jar has ${jar.size} cookies`);
  }
}
