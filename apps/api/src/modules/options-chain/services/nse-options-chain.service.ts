import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OptionsChainEntry } from '@td/shared/types';

/**
 * NSE India's public option-chain API: real open interest, OI change,
 * volume, IV and LTP for every strike of one expiry — data our Angel One
 * `optionGreek` path doesn't reliably deliver.
 *
 * NSE retired `/api/option-chain-indices` (404 "Resource not found" from
 * 2026-10). The replacement is two calls:
 *
 *   1. `option-chain-contract-info?symbol=NIFTY` → `{ expiryDates: ["13-Oct-2026", ...] }`
 *   2. `option-chain-v3?type=Indices|Equity&symbol=NIFTY&expiry=13-Oct-2026`
 *      → `{ records: { data: [{ strikePrice, expiryDates, CE, PE }], underlyingValue } }`
 *
 * Both answer a browser User-Agent with no cookie, so we call them cookieless
 * and only warm the cookie jar (homepage visit) if NSE bounces us with
 * 401/403. A failing warm-up is non-fatal: the homepage 403s datacenter IPs.
 *
 * Endpoints are overridable via NSE_OPTION_CHAIN_INFO_URL /
 * NSE_OPTION_CHAIN_V3_URL because NSE moves these without notice.
 */

/** One leg (CE or PE) of a v3 row. */
interface NseV3Leg {
  strikePrice?: number;
  /** v3 leg-level expiry is "13-10-2026" (numeric month), not the row's "13-Oct-2026". */
  expiryDate?: string;
  openInterest?: number;
  changeinOpenInterest?: number;
  totalTradedVolume?: number;
  impliedVolatility?: number;
  lastPrice?: number;
  /** v3: best bid/ask (the retired endpoint used bidprice/askPrice). */
  buyPrice1?: number;
  sellPrice1?: number;
  /** Retired-endpoint names, read as a fallback in case NSE reintroduces them. */
  bidprice?: number;
  askPrice?: number;
}

interface NseV3Row {
  strikePrice: number;
  /** v3 names the row-level expiry `expiryDates` (a single string). */
  expiryDates?: string;
  /** Retired-endpoint name for the same field. */
  expiryDate?: string;
  CE?: NseV3Leg;
  PE?: NseV3Leg;
}

interface NseV3Response {
  records?: {
    data?: NseV3Row[];
    underlyingValue?: number;
    expiryDates?: string[];
    timestamp?: string;
  };
}

interface NseContractInfo {
  expiryDates?: string[];
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const NSE_HOME = 'https://www.nseindia.com';
const DEFAULT_INFO_URL = 'https://www.nseindia.com/api/option-chain-contract-info';
const DEFAULT_V3_URL = 'https://www.nseindia.com/api/option-chain-v3';

const CHAIN_CACHE_TTL_MS = 30_000;
const EXPIRY_CACHE_TTL_MS = 10 * 60 * 1000;
const COOKIE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** NSE index underlyings (v3 `type=Indices`); anything else is `type=Equity`. */
const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

/** NSE F&O symbols are upper-case alphanumerics plus & and - (e.g. M&M, BAJAJ-AUTO). */
const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,20}$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Browser-like headers so NSE doesn't bounce us as a bot. Never logged. */
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

/**
 * Describe a fetch failure without hiding the cause. Undici reports every
 * network error as `TypeError: fetch failed` with the real reason
 * (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ...) on `err.cause`.
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    parts.push(`cause=${code ? `${code} ` : ''}${cause.message}`);
  } else if (cause !== undefined) {
    parts.push(`cause=${String(cause)}`);
  }
  return parts.join(' | ');
}

@Injectable()
export class NseOptionsChainService {
  private readonly logger = new Logger(NseOptionsChainService.name);

  private readonly infoUrl: string;
  private readonly v3Url: string;

  private cookieHeader: string | null = null;
  private cookieSetAt = 0;

  private readonly expiryCache = new Map<string, CacheEntry<string[]>>();
  private readonly chainCache = new Map<string, CacheEntry<NseV3Response>>();

  constructor(config: ConfigService) {
    this.infoUrl = config.get<string>('NSE_OPTION_CHAIN_INFO_URL') || DEFAULT_INFO_URL;
    this.v3Url = config.get<string>('NSE_OPTION_CHAIN_V3_URL') || DEFAULT_V3_URL;
  }

  /**
   * Fetch the NSE option chain for one expiry, mapped into our internal
   * OptionsChainEntry shape. `expiry` is ISO (2026-10-13); when omitted the
   * nearest listed expiry on or after today (IST) is used.
   *
   * Returns null when the symbol is invalid, the requested expiry isn't
   * listed by NSE, the network call fails, or NSE returns malformed data —
   * callers fall back gracefully. A requested-but-unlisted expiry is NOT
   * silently swapped for another one: callers persist the result under the
   * expiry they asked for.
   */
  async getChain(
    underlying: string,
    expiry?: string,
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number } | null> {
    const symbol = underlying.toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) {
      this.logger.debug(`NSE chain: ${symbol} is not an NSE symbol, skipping`);
      return null;
    }

    const expiries = await this.fetchExpiries(symbol);
    if (!expiries || expiries.length === 0) return null;

    const nseExpiry = this.selectExpiry(expiries, expiry);
    if (!nseExpiry) {
      this.logger.warn(
        `NSE chain: ${symbol} expiry ${expiry ?? '(nearest)'}` +
          `${expiry ? ` (mapped to ${this.toNseExpiry(expiry)})` : ''} not listed. ` +
          `Available: ${expiries.slice(0, 5).join(', ')}`,
      );
      return null;
    }

    const raw = await this.fetchV3Chain(symbol, nseExpiry);
    if (!raw?.records?.data) return null;

    const spotPrice = Number(raw.records.underlyingValue ?? 0);
    const rows = raw.records.data.filter(
      (r) => (r.expiryDates ?? r.expiryDate ?? nseExpiry) === nseExpiry,
    );
    if (rows.length === 0) {
      this.logger.warn(`NSE chain: ${symbol} ${nseExpiry} returned no strikes`);
      return null;
    }

    const expiryLabel = expiry ?? this.fromNseExpiry(nseExpiry);
    const chain: OptionsChainEntry[] = rows.map((r) => ({
      strikePrice: Number(r.strikePrice),
      expiryDate: expiryLabel,
      ceData: this.mapLeg(r.CE),
      peData: this.mapLeg(r.PE),
    }));
    chain.sort((a, b) => a.strikePrice - b.strikePrice);

    this.logger.log(
      `NSE chain: ${chain.length} strikes for ${symbol} ${nseExpiry}, spot=${spotPrice}`,
    );
    return { chain, spotPrice };
  }

  private mapLeg(leg?: NseV3Leg) {
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
      bidPrice: Number(leg.buyPrice1 ?? leg.bidprice ?? 0),
      askPrice: Number(leg.sellPrice1 ?? leg.askPrice ?? 0),
    };
  }

  /**
   * Requested expiry → its NSE label if listed, else null.
   * No request → the earliest listed expiry on or after today's IST date.
   */
  private selectExpiry(expiries: string[], requested?: string): string | null {
    if (requested) {
      const wanted = this.toNseExpiry(requested);
      return expiries.includes(wanted) ? wanted : null;
    }
    const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const upcoming = expiries
      .map((e) => ({ label: e, iso: this.fromNseExpiry(e) }))
      .filter((e) => e.iso && e.iso >= todayIst)
      .sort((a, b) => a.iso.localeCompare(b.iso));
    return upcoming[0]?.label ?? null;
  }

  /** ISO (2026-04-12) → NSE display format (12-Apr-2026). */
  private toNseExpiry(iso: string): string {
    const d = new Date(iso);
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${day}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }

  /** NSE display format (12-Apr-2026) → ISO date (2026-04-12); '' if unparseable. */
  private fromNseExpiry(label: string): string {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(label);
    if (!m) return '';
    const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (month < 0) return '';
    return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  private async fetchExpiries(symbol: string): Promise<string[] | null> {
    const cached = this.expiryCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < EXPIRY_CACHE_TTL_MS) return cached.data;

    const url = `${this.infoUrl}?symbol=${encodeURIComponent(symbol)}`;
    const data = await this.fetchJson<NseContractInfo>(url, `${symbol} contract-info`);
    const expiries = Array.isArray(data?.expiryDates) ? data!.expiryDates : null;
    if (!expiries || expiries.length === 0) {
      if (data) this.logger.warn(`NSE ${symbol} contract-info: no expiryDates in response`);
      return null;
    }
    this.expiryCache.set(symbol, { data: expiries, fetchedAt: Date.now() });
    return expiries;
  }

  private async fetchV3Chain(symbol: string, nseExpiry: string): Promise<NseV3Response | null> {
    const key = `${symbol}|${nseExpiry}`;
    const cached = this.chainCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CHAIN_CACHE_TTL_MS) return cached.data;

    const type = INDEX_SYMBOLS.has(symbol) ? 'Indices' : 'Equity';
    const url =
      `${this.v3Url}?type=${type}&symbol=${encodeURIComponent(symbol)}` +
      `&expiry=${encodeURIComponent(nseExpiry)}`;
    const data = await this.fetchJson<NseV3Response>(url, `${symbol} ${nseExpiry} chain`);
    if (!data) return null;
    if (!Array.isArray(data.records?.data)) {
      this.logger.warn(`NSE ${symbol} ${nseExpiry} chain: HTTP 200 but no records.data`);
      return null;
    }
    this.chainCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }

  /**
   * GET a JSON endpoint. Cookieless first; on 401/403 warm the cookie jar
   * once and retry. Returns null (never throws) on network error, non-2xx or
   * unparseable body, logging the cause / HTTP status — never headers.
   */
  private async fetchJson<T>(url: string, label: string): Promise<T | null> {
    try {
      let res = await this.apiGet(url);
      if (res.status === 401 || res.status === 403) {
        this.logger.warn(`NSE ${label}: HTTP ${res.status}, warming cookies and retrying`);
        await res.text().catch(() => undefined);
        this.cookieHeader = null;
        this.cookieSetAt = 0;
        await this.ensureCookies();
        res = await this.apiGet(url);
      }
      if (!res.ok) {
        await res.text().catch(() => undefined);
        this.logger.warn(`NSE ${label} fetch failed: HTTP ${res.status} (${url})`);
        return null;
      }
      const text = await res.text();
      if (!text) {
        this.logger.warn(`NSE ${label}: HTTP ${res.status} with empty body`);
        return null;
      }
      return JSON.parse(text) as T;
    } catch (error) {
      this.logger.warn(`NSE ${label} fetch error: ${describeFetchError(error)} (${url})`);
      return null;
    }
  }

  private apiGet(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      ...BROWSER_HEADERS,
      'Accept': 'application/json, text/plain, */*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': `${NSE_HOME}/option-chain`,
    };
    if (this.cookieHeader) headers['Cookie'] = this.cookieHeader;
    return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  /**
   * Visit the NSE homepage (and option-chain page) to collect session
   * cookies. Only used after a 401/403. Every failure here is logged and
   * swallowed: the APIs work without cookies and the homepage 403s
   * datacenter clients. A failed warm-up is also remembered for
   * COOKIE_TTL_MS so we don't re-pay it on every request.
   */
  private async ensureCookies(): Promise<void> {
    if (Date.now() - this.cookieSetAt < COOKIE_TTL_MS) return;

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

    const steps: Array<[string, string, Record<string, string>]> = [
      ['homepage', NSE_HOME, {}],
      ['option-chain page', `${NSE_HOME}/option-chain`, { 'Referer': `${NSE_HOME}/` }],
    ];
    for (const [name, url, extra] of steps) {
      try {
        const headers: Record<string, string> = { ...BROWSER_HEADERS, ...extra };
        if (jar.size > 0) headers['Cookie'] = jarToHeader();
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        collect(res);
        await res.text().catch(() => undefined);
        if (!res.ok) this.logger.warn(`NSE cookie warm-up: ${name} → HTTP ${res.status} (non-fatal)`);
      } catch (error) {
        this.logger.warn(
          `NSE cookie warm-up: ${name} failed (non-fatal): ${describeFetchError(error)}`,
        );
      }
    }

    this.cookieHeader = jar.size > 0 ? jarToHeader() : null;
    this.cookieSetAt = Date.now();
    this.logger.log(`NSE: cookie jar has ${jar.size} cookies`);
  }
}
