import { Injectable, Logger, ServiceUnavailableException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { FundamentalsResponse } from './types';

/**
 * Strip Angel One series suffixes so the symbol we send to Yahoo is the
 * bare ticker. NSE/BSE attach short alphabetic series codes after a hyphen
 * (-EQ, -BE, -BL, -SM, -ST, -AF, -BZ, -IL, -SG, -BT, -SL, -RR, -W1…) to
 * classify listings. Yahoo doesn't carry the series — it expects the bare
 * ticker. We strip any trailing `-XXX` (1-3 alpha chars) suffix, which
 * covers every series code we've encountered without nuking legitimate
 * symbols (no Indian listing has letters after a hyphen unless it's a
 * series classification).
 */
function normalizeSymbol(raw: string): string {
  return raw.toUpperCase().trim().replace(/-[A-Z]{1,3}$/, '');
}

/**
 * Yahoo's quoteSummary fields can come back as either a raw number/string
 * or a `{ raw, fmt, longFmt }` shape depending on the module. This helper
 * unwraps both shapes to a plain number — returns undefined if the value
 * is missing or not a finite number.
 *
 * Examples seen in the wild:
 *   summaryDetail.marketCap        → { raw: 19500000000000, fmt: "19.5T" }
 *   summaryDetail.dividendYield    → { raw: 0.012, fmt: "1.20%" }
 *   summaryDetail.trailingPE       → { raw: 24.5, fmt: "24.50" }
 *   defaultKeyStatistics.beta      → { raw: 0.93, fmt: "0.93" }
 *   financialData.returnOnEquity   → { raw: 0.18, fmt: "18.00%" }
 *   earningsChart.actual           → { raw: 12.34, fmt: "12.34" }
 *
 * In rare cases (esp. when a module 404s but the wrapper returns 200) a
 * field arrives as a bare number — we handle both.
 */
function toNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'object' && value !== null && 'raw' in value) {
    const raw = (value as { raw: unknown }).raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

/**
 * Pull a string out of either a bare string field or a `{ fmt }` wrapper.
 * Used for things like calendar dates where Yahoo gives `{ raw, fmt }`
 * (raw = unix seconds, fmt = "2026-04-29") — we prefer the formatted
 * string so the caller doesn't have to deal with timezone math.
 */
function toFmtString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'fmt' in value) {
    const fmt = (value as { fmt: unknown }).fmt;
    if (typeof fmt === 'string') return fmt;
  }
  return undefined;
}

/**
 * Convert unix seconds (raw or wrapper) to ISO date string. Used when
 * Yahoo only gives `{ raw: 1714435200 }` without a fmt field.
 */
function unixToIsoDate(value: unknown): string | undefined {
  const n = toNumber(value);
  if (n == null || n <= 0) return undefined;
  // Yahoo earnings timestamps are in seconds — guard against accidental ms.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Format an ISO date as "Q4 2025" using the calendar quarter that contains
 * it. Yahoo's `earningsChart.quarterly` entries label each quarter with
 * a `date` like "4Q2025" or just a unix timestamp — this gives us a
 * consistent label regardless of which form arrives.
 */
function quarterLabelFor(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const m = d.getUTCMonth(); // 0-11
  const q = Math.floor(m / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

interface CacheEntry {
  data: FundamentalsResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const YAHOO_MODULES = [
  'summaryDetail',
  'assetProfile',
  'financialData',
  'defaultKeyStatistics',
  'calendarEvents',
  'earnings',
].join(',');

/**
 * Browser-shaped User-Agent. Yahoo's quoteSummary endpoint 401s plain Node
 * UAs — same trick `MarketContextService.getVixHistory` and
 * `YahooFinanceService.getCandles` use. Keep this in sync if Yahoo
 * tightens the heuristic.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Fundamentals service backed by Yahoo Finance's quoteSummary endpoint.
 *
 * - In-memory cache, 24h TTL, keyed by `${exchange}:${symbol}`. Populated
 *   on first hit per symbol; failures are NOT cached so a transient Yahoo
 *   blip doesn't poison the entry for a day.
 * - Throws `ServiceUnavailableException` on any upstream failure
 *   (network error, non-200, malformed JSON, missing `quoteSummary.result`).
 *   The frontend renders a "Fundamentals unavailable + Retry" state on 503.
 *
 * Note: this service does NOT touch `MarketContextService.getIndiaVix` —
 * that's a separate Yahoo call with its own retry/fallback semantics. We
 * intentionally mirror its UA + error-handling pattern instead of sharing
 * code, so the two paths can evolve independently.
 */
@Injectable()
export class FundamentalsService {
  private readonly logger = new Logger(FundamentalsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Yahoo started gating `v10/finance/quoteSummary` in 2024 — every
   * request needs a session cookie + matching `crumb` query param or it
   * returns 401 "Invalid Crumb". We fetch both lazily on first miss and
   * cache them for an hour; on a 401 we re-fetch (handled in
   * `fetchFromYahoo`).
   */
  private session: { cookie: string; crumb: string; expiresAt: number } | null = null;

  constructor(private readonly http: HttpService) {}

  /**
   * Resolve `symbol` + `exchange` to a fundamentals snapshot.
   *
   * Cache hit → returns cached data.
   * Cache miss → fetches from Yahoo, parses, stores, returns. On any
   *   upstream failure, throws ServiceUnavailableException — the caller
   *   (controller) maps that to HTTP 503.
   */
  async get(symbol: string, exchange: 'NSE' | 'BSE'): Promise<FundamentalsResponse> {
    const upper = normalizeSymbol(symbol);
    const key = `${exchange}:${upper}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const data = await this.fetchFromYahoo(upper, exchange);

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return data;
  }

  /**
   * Hit Yahoo's quoteSummary endpoint and parse the response.
   *
   * Handles the Yahoo crumb dance: fetch a session cookie + crumb on first
   * call (or after a 401 invalidation), then call quoteSummary with both
   * attached. Any other failure mode throws ServiceUnavailableException so
   * the caller can surface a clean 503.
   */
  private async fetchFromYahoo(
    symbol: string,
    exchange: 'NSE' | 'BSE',
  ): Promise<FundamentalsResponse> {
    const suffix = exchange === 'BSE' ? 'BO' : 'NS';
    const yahooSymbol = `${symbol}.${suffix}`;

    // First attempt — refresh crumb on 401 and try once more before giving up.
    let raw: any;
    try {
      raw = await this.callQuoteSummary(yahooSymbol);
    } catch (err) {
      // 401 → crumb expired or never had one. Force refresh and retry once.
      if (this.isUnauthorized(err)) {
        this.session = null;
        try {
          raw = await this.callQuoteSummary(yahooSymbol);
        } catch (err2) {
          throw this.toHttpException(err2, yahooSymbol);
        }
      } else {
        throw this.toHttpException(err, yahooSymbol);
      }
    }

    const result = raw?.quoteSummary?.result?.[0];
    if (!result) {
      const upstreamErr =
        raw?.quoteSummary?.error?.description ?? 'No result in Yahoo response';
      this.logger.warn(`Yahoo returned no result for ${yahooSymbol}: ${upstreamErr}`);
      throw new ServiceUnavailableException({
        error: 'fundamentals_unavailable',
        message: upstreamErr,
      });
    }

    return this.parseYahoo(result, symbol, exchange);
  }

  /**
   * Make the actual HTTP GET to quoteSummary, attaching the session
   * cookie + crumb. Lets the caller handle retry-on-401.
   */
  private async callQuoteSummary(yahooSymbol: string): Promise<any> {
    const session = await this.ensureSession();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${YAHOO_MODULES}&crumb=${encodeURIComponent(session.crumb)}`;

    const response = await firstValueFrom(
      this.http.get<any>(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
          Cookie: session.cookie,
        },
      }),
    );
    return response.data;
  }

  /**
   * Lazily fetch + cache a Yahoo session cookie and matching crumb.
   * The crumb itself is stable for hours, but we refresh hourly anyway
   * to stay well clear of Yahoo's expiry.
   */
  private async ensureSession(): Promise<{ cookie: string; crumb: string }> {
    if (this.session && this.session.expiresAt > Date.now()) {
      return this.session;
    }

    // Step 1: hit fc.yahoo.com to get a session cookie. The body is
    // irrelevant — we just need the Set-Cookie header (A3 cookie).
    const cookieRes = await firstValueFrom(
      this.http.get('https://fc.yahoo.com', {
        headers: { 'User-Agent': BROWSER_UA },
        // Yahoo returns a 404 here but still sets the cookie. Don't throw.
        validateStatus: () => true,
      }),
    );
    const setCookie: string[] = (cookieRes.headers as any)?.['set-cookie'] ?? [];
    const cookie = setCookie
      .map((c: string) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!cookie) {
      throw new Error('Yahoo did not return a session cookie');
    }

    // Step 2: exchange that cookie for a crumb. Plain text response.
    const crumbRes = await firstValueFrom(
      this.http.get<string>('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': BROWSER_UA,
          Cookie: cookie,
          Accept: 'text/plain',
        },
        responseType: 'text',
      }),
    );
    const crumb = String(crumbRes.data ?? '').trim();
    if (!crumb || crumb.length > 32) {
      // Yahoo sometimes returns an HTML error page instead of a crumb when
      // the cookie didn't take — bail out cleanly.
      throw new Error('Yahoo returned an invalid crumb');
    }

    this.session = {
      cookie,
      crumb,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    return this.session;
  }

  /** Detect axios's 401 shape so we can refresh the crumb and retry. */
  private isUnauthorized(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as { response?: { status?: number } }).response?.status;
    return status === 401;
  }

  /** Detect axios's 404 shape — Yahoo has no listing for this ticker. */
  private isNotFound(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as { response?: { status?: number } }).response?.status;
    return status === 404;
  }

  /**
   * Wrap an upstream failure as the right HTTP exception:
   *   - Yahoo 404 → NotFoundException (the ticker has no Yahoo listing —
   *     usually an index/F&O/CDS contract that shouldn't have been queried,
   *     or a fresh listing Yahoo hasn't indexed yet). Retrying won't help.
   *   - Anything else → ServiceUnavailableException (transient — Retry is
   *     a sensible UX response).
   */
  private toHttpException(
    err: unknown,
    yahooSymbol: string,
  ): NotFoundException | ServiceUnavailableException {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Yahoo quoteSummary fetch failed for ${yahooSymbol}: ${message}`);
    if (this.isNotFound(err)) {
      return new NotFoundException({
        error: 'fundamentals_not_listed',
        message: `Yahoo Finance has no fundamentals for ${yahooSymbol}`,
      });
    }
    return new ServiceUnavailableException({
      error: 'fundamentals_unavailable',
      message: `Upstream Yahoo Finance request failed: ${message}`,
    });
  }

  /**
   * Parse Yahoo's quoteSummary result block into our flat response shape.
   *
   * Every field is best-effort: Yahoo silently omits modules and fields
   * for some tickers (e.g. fresh listings have no `earnings`, illiquid
   * names have no `beta`), so we use optional chaining + the
   * `toNumber`/`toFmtString` unwrappers throughout.
   */
  private parseYahoo(
    result: any,
    symbol: string,
    exchange: 'NSE' | 'BSE',
  ): FundamentalsResponse {
    const summary = result.summaryDetail ?? {};
    const profile = result.assetProfile ?? {};
    const financial = result.financialData ?? {};
    const stats = result.defaultKeyStatistics ?? {};
    const calendar = result.calendarEvents?.earnings ?? {};
    const earningsChart = result.earnings?.earningsChart ?? {};

    // Yahoo's `summaryDetail.dividendYield` is a decimal (0.012 = 1.2%) and
    // is what we actually want. `summaryDetail.trailingAnnualDividendYield`
    // is also available as a fallback for some tickers — try both.
    const dividendYield =
      toNumber(summary.dividendYield) ??
      toNumber(summary.trailingAnnualDividendYield);

    // `nextEarningsDate` lives in calendarEvents.earnings.earningsDate, which
    // is an array of `{ raw, fmt }` objects (sometimes one entry, sometimes
    // a [start, end] pair when Yahoo only knows the window). Take the first.
    const nextEarningsDate = (() => {
      const arr = calendar?.earningsDate;
      if (!Array.isArray(arr) || arr.length === 0) return undefined;
      return toFmtString(arr[0]) ?? unixToIsoDate(arr[0]);
    })();

    // Recent quarters: earningsChart.quarterly is an array of
    // { date: "1Q2025", actual: {raw,fmt}, estimate: {raw,fmt} }.
    // Yahoo gives at most 4. We compute surprise % when both sides exist.
    type QuarterEntry = NonNullable<FundamentalsResponse['recentEarnings']>[number];
    const recentEarnings: QuarterEntry[] | undefined = Array.isArray(earningsChart.quarterly)
      ? earningsChart.quarterly
          .map((q: any): QuarterEntry => {
            const reported = toNumber(q?.actual);
            const estimate = toNumber(q?.estimate);
            const surprise =
              reported != null && estimate != null && estimate !== 0
                ? ((reported - estimate) / Math.abs(estimate)) * 100
                : undefined;

            // Date can be either a "1Q2025" string or a unix wrapper.
            const rawDate = q?.date;
            let isoDate: string;
            let quarter: string;
            if (typeof rawDate === 'string' && /^[1-4]Q\d{4}$/.test(rawDate)) {
              quarter = `Q${rawDate[0]} ${rawDate.slice(2)}`;
              // Best-effort: pin to last day of the quarter for ISO.
              const qn = Number(rawDate[0]);
              const yn = Number(rawDate.slice(2));
              isoDate = new Date(Date.UTC(yn, qn * 3, 0)).toISOString().slice(0, 10);
            } else {
              const d = unixToIsoDate(rawDate) ?? '';
              isoDate = d;
              quarter = d ? quarterLabelFor(d) : 'Unknown';
            }

            return {
              quarter,
              date: isoDate,
              reportedEPS: reported,
              estimateEPS: estimate,
              surprise: surprise != null ? Math.round(surprise * 10) / 10 : undefined,
            };
          })
          .slice(-4)
      : undefined;

    return {
      symbol,
      exchange,
      fetchedAt: Date.now(),

      sector: typeof profile.sector === 'string' ? profile.sector : undefined,
      industry: typeof profile.industry === 'string' ? profile.industry : undefined,

      marketCap: toNumber(summary.marketCap) ?? toNumber(stats.marketCap),
      trailingPE: toNumber(summary.trailingPE),
      priceToBook: toNumber(stats.priceToBook),
      trailingEPS: toNumber(stats.trailingEps) ?? toNumber(summary.trailingEps),
      forwardEPS: toNumber(stats.forwardEps),

      returnOnEquity: toNumber(financial.returnOnEquity),
      debtToEquity: toNumber(financial.debtToEquity),

      fiftyTwoWeekHigh: toNumber(summary.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: toNumber(summary.fiftyTwoWeekLow),

      dividendYield,
      beta: toNumber(summary.beta) ?? toNumber(stats.beta),

      nextEarningsDate,
      recentEarnings:
        recentEarnings && recentEarnings.length > 0 ? recentEarnings : undefined,
    };
  }
}
