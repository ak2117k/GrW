import { MarketFeedService } from './market-feed.service';
import { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * Cross-segment token collision (real-money bug) — MarketFeedService side.
 *
 * The in-memory `quoteCache` used to be keyed by TOKEN ALONE, so when Angel
 * One reuses a numeric token across segments (e.g. 7866 = NSE GVPIL equity
 * AND a CDS USDINR currency contract) one segment's tick overwrote the
 * other's quote → phantom prices served to every `getQuote(token)` caller.
 *
 * The cache is now keyed by a composite `${exchange}:${token}`. The public
 * `getQuote(token)` is token-only (external callers depend on that), so it
 * resolves NSE/equity semantics by default but must NEVER return a quote
 * recorded under a different segment.
 */
describe('MarketFeedService — cross-segment token collision', () => {
  /**
   * Build a MarketFeedService with inert collaborators. Only the tick
   * pipeline (handleTick → quoteCache → getQuote) is exercised; Redis,
   * gateway, candle aggregation and the level book are no-ops here.
   */
  function buildFeed(): MarketFeedService {
    const configService = { get: () => undefined } as any;
    const candleAggregator = {
      onCandleClose: jest.fn(),
      processTick: jest.fn(),
      flushAll: jest.fn().mockResolvedValue(undefined),
      setTokenInstrumentId: jest.fn(),
    } as any;
    const instrumentService = {
      getByToken: jest.fn().mockResolvedValue(null),
      getCommodityInstruments: jest.fn().mockReturnValue([]),
      // Exchange-aware resolution: token 509 is NSE MAZDOCK-EQ (and MCX
      // SSUGARMKOLCOM). The quote must label by (exchange, token).
      getByExchangeTokenSync: jest.fn((exchange: string, token: string) =>
        exchange === 'NSE' && token === '509' ? ({ symbol: 'MAZDOCK-EQ' } as any) : null,
      ),
    } as any;
    const gateway = {
      emitTick: jest.fn(),
      emitCandle: jest.fn(),
      emitConnectionStatus: jest.fn(),
      getConnectedClientCount: jest.fn().mockReturnValue(0),
    } as any;
    const brokerAdapter = null;
    const angelOneAuth = { isAuthenticated: () => false } as any;
    const levelBookService = null;

    return new MarketFeedService(
      configService,
      candleAggregator,
      instrumentService,
      gateway,
      brokerAdapter,
      angelOneAuth,
      levelBookService,
    );
  }

  /** Build a tick optionally annotated with its segment. */
  function tick(token: string, ltp: number, exchange?: string): TickData {
    const t: any = {
      token,
      symbol: '',
      ltp,
      open: ltp,
      high: ltp,
      low: ltp,
      close: ltp,
      volume: 0,
      timestamp: new Date(),
    };
    if (exchange) t.exchange = exchange;
    return t as TickData;
  }

  /** Drive the private tick handler. */
  function feedTick(feed: MarketFeedService, t: TickData): void {
    (feed as any).handleTick(t);
  }

  it('does not overwrite an NSE quote with a same-token CDS tick', () => {
    const feed = buildFeed();

    feedTick(feed, tick('7866', 12.5, 'NSE')); // GVPIL equity
    feedTick(feed, tick('7866', 1054.0, 'CDS')); // USDINR currency — same token

    // Token-only getQuote keeps NSE/equity semantics: it must return the
    // 12.5 equity price, NOT the 1054 currency price that arrived later.
    const q = feed.getQuote('7866');
    expect(q).not.toBeNull();
    expect(q!.ltp).toBe(12.5);
  });

  it('keeps both segments retrievable and uncontaminated', () => {
    const feed = buildFeed();

    feedTick(feed, tick('7866', 1054.0, 'CDS'));
    feedTick(feed, tick('7866', 12.5, 'NSE'));

    // getAllQuotes should hold BOTH distinct prices (one per segment),
    // not a single clobbered entry.
    const ltps = feed.getAllQuotes().map((q) => q.ltp).sort((a, b) => a - b);
    expect(ltps).toEqual([12.5, 1054.0]);
  });

  it('a token-only getQuote never returns a foreign-segment-only quote', () => {
    const feed = buildFeed();

    // Only the CDS segment ticked. getQuote('7866') (NSE/equity semantics)
    // must NOT hand back the currency price.
    feedTick(feed, tick('7866', 1054.0, 'CDS'));

    const q = feed.getQuote('7866');
    expect(q?.ltp).not.toBe(1054.0);
  });

  it('getQuote still works for a normal NSE token (no regression)', () => {
    const feed = buildFeed();
    feedTick(feed, tick('2885', 2500, 'NSE'));
    expect(feed.getQuote('2885')!.ltp).toBe(2500);
  });

  it('labels the quote symbol by (exchange, token), not the colliding token-only symbol', () => {
    // A tick for token 509 arrives mislabeled with the MCX collision symbol.
    // The quote must be relabeled to the real NSE instrument (MAZDOCK-EQ).
    const feed = buildFeed();
    const t = tick('509', 2542, 'NSE');
    (t as any).symbol = 'SSUGARMKOLCOM';
    feedTick(feed, t);
    expect(feed.getQuote('509')!.symbol).toBe('MAZDOCK-EQ');
  });

  it('getQuote falls back to the sole cached segment for a non-ambiguous token', () => {
    // A token that only ever streams on MCX (a commodity) is still
    // retrievable token-only — there is no NSE entry, and no collision, so
    // returning the single available segment is correct.
    const feed = buildFeed();
    feedTick(feed, tick('428633', 6100, 'MCX'));
    expect(feed.getQuote('428633')!.ltp).toBe(6100);
  });
});
