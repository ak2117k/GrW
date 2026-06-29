import { Injectable, Logger } from '@nestjs/common';
import { YahooFinanceService } from './yahoo-finance.service';
import { MarketFeedService } from './market-feed.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';

/**
 * Underlying symbol → (token, exchange) used by the spot resolver.
 * Mirrors INDICES + the resolved MCX commodity tokens from
 * `@td/shared/constants`. Inlined here so ts-jest can resolve this file
 * without depending on the workspace package's `exports` field.
 */
const UNDERLYING_TOKEN_MAP: Record<string, { token: string; exchange: string }> = {
  NIFTY: { token: '99926000', exchange: 'NSE' },
  BANKNIFTY: { token: '99926009', exchange: 'NSE' },
  FINNIFTY: { token: '99926037', exchange: 'NSE' },
  MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
  SENSEX: { token: '99919000', exchange: 'BSE' },
};

export type VixRegime = 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';

export interface MarketContextSnapshot {
  underlying: string;
  spot: number | null;
  vix: number | null;
  vixRegime: VixRegime;
  pcr: number | null;
  maxPain: number | null;
  adRatio: number | null;
  capturedAt: Date;
}

/** Look up a known underlying symbol → (token, exchange).
 *  Used to fetch the cached spot price from MarketFeedService.
 *  Returns null for symbols that aren't in the map (the snapshot then
 *  records spot=null instead of failing the whole capture). */
function resolveUnderlyingToken(underlying: string): { token: string; exchange: string } | null {
  const upper = underlying.toUpperCase();
  const entry = UNDERLYING_TOKEN_MAP[upper];
  return entry ?? null;
}

/**
 * Aggregates real-time market context for trade journaling.
 *
 * WHY: M5 requires that every trade entry be stamped with the market state
 * at decision time, so post-hoc journal analysis can correlate outcomes
 * with regime, sentiment, and breadth — not just the trade's own price.
 */
@Injectable()
export class MarketContextService {
  private readonly logger = new Logger(MarketContextService.name);

  constructor(
    private readonly yahoo: YahooFinanceService,
    private readonly feed: MarketFeedService,
    private readonly chain: OptionsChainService,
  ) {}

  /**
   * Bucket a VIX reading into a coarse-grained regime label.
   * Cutoffs:
   *   <12      → LOW       (very calm)
   *   12–18    → NORMAL    (typical Indian-market volatility)
   *   18–25    → ELEVATED  (event risk, results season)
   *   ≥25      → HIGH      (crisis / extreme fear)
   *   null/NaN → UNKNOWN
   */
  classifyVixRegime(vix: number | null | undefined): VixRegime {
    if (vix == null || Number.isNaN(vix)) return 'UNKNOWN';
    if (vix < 12) return 'LOW';
    if (vix < 18) return 'NORMAL';
    if (vix < 25) return 'ELEVATED';
    return 'HIGH';
  }

  /**
   * Capture a market-context snapshot for the given underlying.
   *
   * Each upstream call is wrapped in a tolerant promise so a single
   * failing source does NOT block the snapshot — missing fields come
   * back as null and the trade still records what was available.
   */
  async snapshot(underlying: string): Promise<MarketContextSnapshot> {
    const [spot, vix, breadth, optionsAggregate] = await Promise.all([
      this.tolerant(() => this.resolveSpot(underlying), 'spot'),
      this.tolerant(() => this.yahoo.getIndiaVix(), 'vix'),
      this.tolerant(async () => this.feed.getBreadth(), 'breadth'),
      this.tolerant(() => this.resolveOptionsAggregate(underlying), 'options-aggregate'),
    ]);

    return {
      underlying,
      spot: spot ?? null,
      vix: vix ?? null,
      vixRegime: this.classifyVixRegime(vix ?? null),
      pcr: optionsAggregate?.pcr ?? null,
      maxPain: optionsAggregate?.maxPain ?? null,
      adRatio: breadth?.adRatio ?? null,
      capturedAt: new Date(),
    };
  }

  /**
   * Resolve the current spot for an underlying via the in-memory feed cache.
   * Returns null if the underlying isn't in the cache (graceful degradation
   * — the trade still saves, just without spot context).
   */
  private async resolveSpot(underlying: string): Promise<number | null> {
    const ref = resolveUnderlyingToken(underlying);
    if (!ref) return null;
    const quote = this.feed.getQuote(ref.token);
    if (!quote || !Number.isFinite(quote.ltp) || quote.ltp <= 0) return null;
    return quote.ltp;
  }

  /**
   * Fetch the options chain for the nearest expiry of `underlying` and derive
   * PCR + max-pain from it. Returns null when no chain / expiries are
   * available — those fields then come back as null in the snapshot.
   */
  private async resolveOptionsAggregate(
    underlying: string,
  ): Promise<{ pcr: number | null; maxPain: number | null } | null> {
    const expiries = await this.chain.getExpiries(underlying);
    if (!expiries || expiries.length === 0) return null;

    const nearest = expiries[0];
    const { chain } = await this.chain.getOptionsChainWithSpot(underlying, nearest);
    if (!chain || chain.length === 0) return null;

    const pcr = this.chain.getPCR(chain);
    const maxPain = this.chain.getMaxPain(chain);

    return {
      // Treat 0 as "couldn't compute" — getPCR returns 0 when totalCEOI is 0
      // and getMaxPain returns 0 when chain is empty.
      pcr: pcr > 0 ? pcr : null,
      maxPain: maxPain > 0 ? maxPain : null,
    };
  }

  /**
   * Returns today's VIX and yesterday's VIX (closest available trading day),
   * sourced from Yahoo's daily ^INDIAVIX series. Returns null when either
   * value is missing.
   *
   * Used by the VolatilityFactor in the context-scoring engine to classify
   * volatility direction (rising / flat / falling). Best-effort: any failure
   * resolves to null so the factor degrades to NEUTRAL with a "no VIX data"
   * reason instead of crashing the score.
   */
  async getVixHistory(): Promise<{ today: number; yesterday: number } | null> {
    try {
      // ^INDIAVIX is supported by YahooFinanceService.getCandles via the
      // INDICES symbol-token map. Token '99926037' is wrong here — INDIAVIX
      // doesn't have an Angel One INDICES token in the current map. Fall
      // back to a direct Yahoo fetch via the same chart endpoint
      // getIndiaVix uses, but extract the last two daily closes.
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('^INDIAVIX')}?interval=1d&range=5d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as any;
      const result = data?.chart?.result?.[0];
      const closes: Array<number | null> | undefined = result?.indicators?.quote?.[0]?.close;
      if (!closes || closes.length < 2) return null;

      // Walk from the end and pick the two most recent non-null closes.
      const recent: number[] = [];
      for (let i = closes.length - 1; i >= 0 && recent.length < 2; i--) {
        const c = closes[i];
        if (typeof c === 'number' && Number.isFinite(c)) recent.push(c);
      }
      if (recent.length < 2) return null;

      return { today: recent[0], yesterday: recent[1] };
    } catch (err) {
      this.logger.warn(
        `MarketContext: failed to fetch VIX history: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Run a fetch and turn any throw into a logged warning + null result.
   * Used so the snapshot is best-effort: each source can fail independently.
   */
  private async tolerant<T>(fn: () => Promise<T> | T, label: string): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(
        `MarketContext: failed to capture ${label}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
