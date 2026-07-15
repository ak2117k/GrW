import { AngelOneAdapterService, AngelThrottleError } from './angel-one-adapter.service';
import { AngelOneAuthService } from './angel-one-auth.service';
import { AngelOneWebSocketService } from './angel-one-websocket.service';
import { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * Unit tests for AngelOneAdapterService.getMarketDepth — the only piece
 * of the adapter that's pure shape-mapping (no I/O, no scrip-master
 * lookups). The other methods are integration-bound.
 */
describe('AngelOneAdapterService.getMarketDepth', () => {
  function buildAdapter(marketDataMock: jest.Mock) {
    const fakeAuth = {
      getSmartApi: () => ({ marketData: marketDataMock }),
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    return new AngelOneAdapterService(fakeAuth, fakeWs);
  }

  it('maps Angel One depth.buy / depth.sell into the MarketDepth shape', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            depth: {
              buy: [
                { price: 100, quantity: 10, orders: 1 },
                { price: 99.5, quantity: 20, orders: 2 },
              ],
              sell: [
                { price: 100.5, quantity: 15, orders: 1 },
                { price: 101, quantity: 25, orders: 3 },
              ],
            },
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');

    expect(depth).not.toBeNull();
    expect(depth!.bids).toHaveLength(2);
    expect(depth!.bids[0]).toEqual({ price: 100, qty: 10, orders: 1 });
    expect(depth!.asks[0]).toEqual({ price: 100.5, qty: 15, orders: 1 });
    expect(depth!.totalBidQty).toBe(30);
    expect(depth!.totalAskQty).toBe(40);
    expect(depth!.token).toBe('3045');
    expect(depth!.exchange).toBe('NSE');
    expect(typeof depth!.ts).toBe('number');
  });

  it('truncates beyond 5 levels per side', async () => {
    const tenLevels = Array.from({ length: 10 }, (_, i) => ({
      price: 100 - i * 0.05,
      quantity: 10,
      orders: 1,
    }));
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [{ depth: { buy: tenLevels, sell: tenLevels } }],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');
    expect(depth!.bids).toHaveLength(5);
    expect(depth!.asks).toHaveLength(5);
  });

  it('serves the same response from cache within the 1.5s TTL', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            depth: {
              buy: [{ price: 100, quantity: 10, orders: 1 }],
              sell: [{ price: 100.5, quantity: 5, orders: 1 }],
            },
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const a = await adapter.getMarketDepth('3045', 'NSE');
    const b = await adapter.getMarketDepth('3045', 'NSE');
    expect(mock).toHaveBeenCalledTimes(1);
    // Same cached object reference confirms cache hit.
    expect(a).toBe(b);
  });

  it('returns null on SDK errors (graceful degradation)', async () => {
    const mock = jest.fn().mockRejectedValue(new Error('403 forbidden'));
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('99926000', 'NSE');
    expect(depth).toBeNull();
  });

  it('returns an empty depth (cached briefly) when the broker reports no levels', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: { fetched: [{ depth: { buy: [], sell: [] } }] },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('99926000', 'NSE');
    expect(depth).not.toBeNull();
    expect(depth!.bids).toHaveLength(0);
    expect(depth!.asks).toHaveLength(0);
    expect(depth!.totalBidQty).toBe(0);
    expect(depth!.totalAskQty).toBe(0);
  });

  it('falls back to the camelCase bestBids/bestAsks shape when present', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            bestBids: [{ price: 250.1, quantity: 100, orders: 5 }],
            bestAsks: [{ price: 250.2, quantity: 80, orders: 4 }],
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');
    expect(depth!.bids[0]).toEqual({ price: 250.1, qty: 100, orders: 5 });
    expect(depth!.asks[0]).toEqual({ price: 250.2, qty: 80, orders: 4 });
  });
});

/**
 * Task B — getHistoricalData in-memory TTL cache, and
 * Task C — detectable throttle (AngelThrottleError) for the data:null case.
 */
describe('AngelOneAdapterService — historical cache + throttle detection', () => {
  /** Build an adapter whose SmartAPI exposes a controllable getCandleData. */
  function buildAdapter(getCandleData: jest.Mock) {
    const fakeAuth = {
      getSmartApi: () => ({ getCandleData }),
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    const adapter = new AngelOneAdapterService(fakeAuth, fakeWs);
    // Stub the internal delay primitive so the historical pacer AND the
    // throttle-retry backoff resolve instantly — keeps the suite fast and
    // off real 1-2s timers (a throttled single-shot fetch is retried twice).
    jest
      .spyOn(adapter as any, 'sleep')
      .mockImplementation(() => Promise.resolve());
    return adapter;
  }

  /** One candle row in Angel's array shape: [ts, o, h, l, c, v]. */
  function row(ts: string, c = 100): [string, number, number, number, number, number] {
    return [ts, c, c + 1, c - 1, c, 1000];
  }

  // ─── Task B: cache ────────────────────────────────────────────────────
  // NOTE: the historical cache only applies to LIVE fetches — `to` within
  // ~2 minutes of now (see "live-window guard" below). These cache-behaviour
  // tests therefore use a now-anchored `to`; an old `to` deliberately
  // bypasses the cache (backtest replay path).
  describe('candle cache', () => {
    /** A small live window: `to` ≈ now, `from` 15 minutes earlier. */
    function liveWindow(): { from: Date; to: Date } {
      const to = new Date();
      const from = new Date(to.getTime() - 15 * 60 * 1000);
      return { from, to };
    }

    it('serves a repeated fetch (same token:exchange:timeframe) from cache within TTL', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15'), row('2026-05-15 09:16')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);

      expect(mock).toHaveBeenCalledTimes(1); // second call served from cache
      expect(b).toEqual(a);
      expect(b).toHaveLength(2);
    });

    it('refetches once the TTL has expired', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      jest.useFakeTimers({ now: to.getTime() });
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
        // Advance past the 1m TTL (~45s).
        jest.advanceTimersByTime(60_000);
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      } finally {
        jest.useRealTimers();
      }
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache an empty result (genuine data:[])', async () => {
      const mock = jest.fn().mockResolvedValue({ status: true, data: [] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(a).toEqual([]);
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(b).toEqual([]);
      // Empty result must not be cached — the broker is re-hit.
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache a throttled (data:null) result', async () => {
      const mock = jest.fn().mockResolvedValue({ status: false, data: null, message: 'throttled' });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      // A throttle is contained → returns [] (never thrown to the caller).
      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(a).toEqual([]);
      const callsAfterFirst = mock.mock.calls.length;
      // A second call must re-hit the broker (a throttled [] is never cached).
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(b).toEqual([]);
      // The single-shot path retries a throttle before giving up, so each
      // getHistoricalData call issues >1 getCandleData call. The point of this
      // test is that the SECOND getHistoricalData re-hits the broker (nothing
      // was cached) — assert the call count strictly grew rather than pinning
      // an exact number that the retry schedule would make brittle.
      expect(mock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('keys the cache by token:exchange:timeframe — different tokens do not collide', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('99926000', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('2885', 'NSE', '5m', from, to);
      // Three distinct keys → three broker calls.
      expect(mock).toHaveBeenCalledTimes(3);
      // Re-request the first key → still cached.
      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(mock).toHaveBeenCalledTimes(3);
    });

    // ─── Interactive (live-chart) age cap ───────────────────────────────
    // A live chart re-fetches every ~20s expecting the newest completed bar.
    // The per-timeframe TTL (1m→45s, 15m→10min) is tuned for background
    // scoring reuse and is far too long for that — it froze the chart on the
    // same snapshot. INTERACTIVE reads are therefore capped at 15s of age;
    // BACKGROUND reads keep the full TTL.
    it('does NOT serve an INTERACTIVE fetch a cache entry older than the 15s cap', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      jest.useFakeTimers({ now: to.getTime() });
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'interactive');
        // 16s later: still within the 45s 1m TTL, but past the 15s cap.
        jest.advanceTimersByTime(16_000);
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'interactive');
      } finally {
        jest.useRealTimers();
      }
      // Interactive refetched fresh instead of serving the stale snapshot.
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('DOES serve an interactive fetch from cache when the entry is still fresh (<15s)', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      jest.useFakeTimers({ now: to.getTime() });
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'interactive');
        jest.advanceTimersByTime(5_000); // 5s < 15s cap
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'interactive');
      } finally {
        jest.useRealTimers();
      }
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('still serves a BACKGROUND fetch at that same 16s age (cap is interactive-only)', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const { from, to } = liveWindow();

      jest.useFakeTimers({ now: to.getTime() });
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'background');
        jest.advanceTimersByTime(16_000); // past 15s cap, within 45s TTL
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to, 'background');
      } finally {
        jest.useRealTimers();
      }
      // Background is unaffected by the interactive cap → served from cache.
      expect(mock).toHaveBeenCalledTimes(1);
    });

    // ─── Bulk (deep-history backfill) cache bypass ──────────────────────
    // The cache key is token:exchange:timeframe and IGNORES [from,to]. A
    // backfill asking for 120 days of 15m would otherwise be handed the ~7-day
    // window a live scan cached (truncating its dataset), and its own 120-day
    // array would be published under the shared key to live consumers — one of
    // which drives a real intraday trailing stop. Bulk therefore neither reads
    // nor writes the cache.
    // These use the '1d' timeframe deliberately. Sub-hour intervals are capped
    // at 1 day by TIMEFRAME_MAX_RANGE_DAYS, so a 120-day 15m request auto-chunks
    // into 120 broker calls and the call counts stop being legible. ONE_DAY's cap
    // is 1800 days, so a 365-day window is a single call — and 365d of '1d' is
    // exactly what the backfill asks for, making this the real C1 case: it was
    // served the live scan's ~7 bars, fell under the >= 25 guard, and wrote ZERO
    // rows silently.
    /** The backfill's real '1d' window: 365 days back from now. */
    function deepWindow(): { from: Date; to: Date } {
      const to = new Date();
      const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
      return { from, to };
    }
    /** What a live scan leaves under the same key: ~7 days. */
    function scanWindow(): { from: Date; to: Date } {
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from, to };
    }
    const sevenBars = {
      status: true,
      data: Array.from({ length: 7 }, (_, i) => row(`2026-05-${10 + i} 09:15`)),
    };
    const yearOfBars = {
      status: true,
      data: Array.from({ length: 250 }, (_, i) => row(`2026-05-15 09:${String(i % 60).padStart(2, '0')}`)),
    };

    it('does NOT serve a BULK fetch from cache — it hits the broker for its own window', async () => {
      const mock = jest
        .fn()
        .mockResolvedValueOnce(sevenBars)
        .mockResolvedValue(yearOfBars);
      const adapter = buildAdapter(mock);

      // A live scan populates 2885:NSE:1d with its short ~7-bar window.
      const scan = scanWindow();
      const scanned = await adapter.getHistoricalData('2885', 'NSE', '1d', scan.from, scan.to, 'background');
      expect(scanned).toHaveLength(7);
      expect(mock).toHaveBeenCalledTimes(1);

      // The backfill asks for 365 days under the SAME key. It must NOT be
      // handed the cached 7-bar window (which would fail the >= 25 guard).
      const deep = deepWindow();
      const bulk = await adapter.getHistoricalData('2885', 'NSE', '1d', deep.from, deep.to, 'bulk');

      expect(mock).toHaveBeenCalledTimes(2); // hit the broker, not the cache
      expect(bulk).toHaveLength(250); // its own deep window, not the truncated 7
    });

    it('does NOT let a BULK fetch write the cache — a later background read is unaffected', async () => {
      const mock = jest
        .fn()
        .mockResolvedValueOnce(yearOfBars)
        .mockResolvedValue(sevenBars);
      const adapter = buildAdapter(mock);

      // Backfill runs first. Its `to` is now, so it PASSES the live-window
      // guard — this is precisely why that guard did not stop the poisoning.
      const deep = deepWindow();
      const bulk = await adapter.getHistoricalData('2885', 'NSE', '1d', deep.from, deep.to, 'bulk');
      expect(bulk).toHaveLength(250);
      expect(mock).toHaveBeenCalledTimes(1);

      // A live consumer now reads the same key. It must NOT receive the 250-bar
      // bulk array — that is the trailing-stop poisoning path.
      const scan = scanWindow();
      const live = await adapter.getHistoricalData('2885', 'NSE', '1d', scan.from, scan.to, 'background');
      expect(mock).toHaveBeenCalledTimes(2); // bulk cached nothing → broker hit
      expect(live).toHaveLength(7); // its own short window, not the bulk one
    });

    it('does NOT serve a BULK fetch even a cache entry well inside its TTL', async () => {
      const mock = jest.fn().mockResolvedValue(sevenBars);
      const adapter = buildAdapter(mock);
      const scan = scanWindow();

      jest.useFakeTimers({ now: scan.to.getTime() });
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1d', scan.from, scan.to, 'background');
        // 1s later a background read is certainly served from cache (1d TTL is
        // 2h). Bulk must still bypass: the bypass is about the cached WINDOW
        // being wrong for this caller, not about the entry being stale.
        jest.advanceTimersByTime(1_000);
        const deep = deepWindow();
        await adapter.getHistoricalData('2885', 'NSE', '1d', deep.from, deep.to, 'bulk');
      } finally {
        jest.useRealTimers();
      }
      expect(mock).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Historical cache live-window guard (backtest replay bypass) ──────
  describe('cache live-window guard', () => {
    it('bypasses the cache entirely for an old `to` (backtest replay) — every call hits the broker', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-04-17 09:15')] });
      const adapter = buildAdapter(mock);
      // `to` 30 days in the past — a backtest as-of replay, not a live fetch.
      const to = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const from = new Date(to.getTime() - 15 * 60 * 1000);

      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      // No caching for old `to` — broker hit every time.
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it('an old-`to` fetch does NOT populate the cache — a later live fetch still hits the broker', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-04-17 09:15')] });
      const adapter = buildAdapter(mock);

      // Backtest replay first (old `to`).
      const oldTo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const oldFrom = new Date(oldTo.getTime() - 15 * 60 * 1000);
      await adapter.getHistoricalData('2885', 'NSE', '1m', oldFrom, oldTo);
      expect(mock).toHaveBeenCalledTimes(1);

      // Now a LIVE fetch of the same key — must NOT be served the poisoned
      // backtest entry; must hit the broker (and then cache).
      const liveTo = new Date();
      const liveFrom = new Date(liveTo.getTime() - 15 * 60 * 1000);
      await adapter.getHistoricalData('2885', 'NSE', '1m', liveFrom, liveTo);
      expect(mock).toHaveBeenCalledTimes(2);
      // The live fetch DID cache — a repeat live fetch is served from cache.
      await adapter.getHistoricalData('2885', 'NSE', '1m', liveFrom, liveTo);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('a live fetch is not served from a cache entry created by a backtest replay', async () => {
      // Live fetch first → cached. Then an old-`to` fetch bypasses the cache
      // and must NOT be served the live entry (different data window).
      const liveData = { status: true, data: [row('2026-05-17 09:15')] };
      const oldData = { status: true, data: [row('2026-04-17 09:15')] };
      const mock = jest
        .fn()
        .mockResolvedValueOnce(liveData)
        .mockResolvedValueOnce(oldData);
      const adapter = buildAdapter(mock);

      const liveTo = new Date();
      const liveFrom = new Date(liveTo.getTime() - 15 * 60 * 1000);
      await adapter.getHistoricalData('2885', 'NSE', '1m', liveFrom, liveTo);

      const oldTo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const oldFrom = new Date(oldTo.getTime() - 15 * 60 * 1000);
      const backtest = await adapter.getHistoricalData('2885', 'NSE', '1m', oldFrom, oldTo);

      // Backtest call bypassed the cache and got its own (old) data.
      expect(mock).toHaveBeenCalledTimes(2);
      expect(backtest[0].timestamp).toEqual(new Date('2026-04-17 09:15'));
    });
  });

  // ─── Task C: detectable throttle ──────────────────────────────────────
  describe('throttle detection (data:null)', () => {
    it('contains a throttle (data:null) — returns [] and logs a warning, never throws to callers', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: false, data: null, message: 'Access denied because of exceeding access rate' });
      const adapter = buildAdapter(mock);
      const warn = jest
        .spyOn((adapter as any).logger, 'warn')
        .mockImplementation(() => {});
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      // Detectable but contained: getHistoricalData keeps the [] contract for
      // all callers, and surfaces the throttle via a WARN log.
      const result = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('returns [] (does NOT throw) for a genuine empty data:[] response', async () => {
      const mock = jest.fn().mockResolvedValue({ status: true, data: [] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      const result = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(result).toEqual([]);
    });
  });
});

/**
 * Throttle-resilience of getHistoricalData's chunk handling.
 *
 * The adapter auto-chunks a wide date range into per-day windows (sub-hour
 * intervals are capped at 1 day). When a single chunk is throttled by Angel
 * One (data:null → AngelThrottleError), the multi-chunk loop must NOT discard
 * the chunks that already succeeded — it retries with backoff, and on a
 * persistent throttle drops just that one chunk and returns a PARTIAL result.
 * The single-shot (non-chunked) path also retries; a persistent throttle
 * there propagates so getHistoricalData's outer catch returns [].
 */
describe('AngelOneAdapterService — historical chunk throttle resilience', () => {
  /**
   * Build an adapter with a controllable fake smartApi. `getCandleData` is a
   * jest.fn the test wires up per-call. The internal `sleep` primitive (used
   * by the chunk pacer, the inter-call gap, AND the retry backoff) is stubbed
   * to resolve immediately so backoff delays don't slow the suite.
   */
  function makeAdapter(getCandleData: jest.Mock) {
    const fakeAuth = {
      getSmartApi: () => ({ getCandleData }),
      isAuthenticated: () => true,
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    const adapter = new AngelOneAdapterService(fakeAuth, fakeWs);
    jest
      .spyOn(adapter as any, 'sleep')
      .mockImplementation(() => Promise.resolve());
    return adapter;
  }

  /** A SmartAPI getCandleData success response with one candle row. */
  function candleResponse(isoTs: string) {
    return {
      status: true,
      message: 'SUCCESS',
      data: [[isoTs, 100, 110, 90, 105, 1000]],
    };
  }

  /** The throttle response shape: HTTP 200 with data:null. */
  const throttleResponse = {
    status: true,
    message: 'Access denied because of exceeding access rate',
    errorcode: 'AB1004',
    data: null,
  };

  // A 7-day range with a 1-day cap (15m interval) → 7 one-day chunks.
  const FROM = new Date('2026-05-04T00:00:00');
  const TO = new Date('2026-05-11T00:00:00');

  it('formats fromdate/todate for Angel in IST regardless of server timezone', async () => {
    // Angel's getCandleData interprets fromdate/todate as IST wall-clock. The
    // API runs on Render in UTC; formatting with local getHours() sent a
    // `todate` 5:30h early, so the live edge came back ~5.5h stale (e.g. at
    // 20:22 IST the chart stopped at 14:45). These instants are given in UTC;
    // Angel must receive their IST wall-clock equivalents.
    const getCandleData = jest
      .fn()
      .mockResolvedValue(candleResponse('2026-07-14T14:45:00+05:30'));
    const adapter = makeAdapter(getCandleData);

    // 09:00Z = 14:30 IST, 09:15Z = 14:45 IST (single-shot, one call).
    const from = new Date('2026-07-14T09:00:00Z');
    const to = new Date('2026-07-14T09:15:00Z');
    await adapter.getHistoricalData('12345', 'MCX', '15m', from, to, 'interactive');

    expect(getCandleData).toHaveBeenCalledTimes(1);
    const params = getCandleData.mock.calls[0][0];
    expect(params.fromdate).toBe('2026-07-14 14:30');
    expect(params.todate).toBe('2026-07-14 14:45');
  });

  it('returns the other 6 chunks when one chunk is throttled on every attempt', async () => {
    // The chunk whose window starts on day 07 throttles on every attempt;
    // all other chunks succeed. Identify the chunk by its fromdate so the
    // retries of that same chunk also return the throttle response.
    const getCandleData = jest.fn().mockImplementation((params: any) => {
      const day = params.fromdate.slice(8, 10); // "DD"
      if (day === '07') {
        return Promise.resolve(throttleResponse);
      }
      return Promise.resolve(candleResponse(`2026-05-${day}T09:15:00+05:30`));
    });

    const adapter = makeAdapter(getCandleData);
    const result = await adapter.getHistoricalData('12345', 'NSE', '15m', FROM, TO);

    // 7 chunks, one fully throttled → 6 candles survive (PARTIAL, not []).
    expect(result).toHaveLength(6);
    const days = result
      .map((c) => String(c.timestamp.getDate()).padStart(2, '0'))
      .sort();
    expect(days).toEqual(['04', '05', '06', '08', '09', '10']);
    // The throttled chunk was attempted 3 times (1 initial + 2 retries);
    // the 6 healthy chunks once each → 9 getCandleData calls total.
    expect(getCandleData).toHaveBeenCalledTimes(9);
  });

  it('includes a chunk that throttles once then succeeds on retry', async () => {
    const attemptsByDay: Record<string, number> = {};
    const getCandleData = jest.fn().mockImplementation((params: any) => {
      const day = params.fromdate.slice(8, 10);
      attemptsByDay[day] = (attemptsByDay[day] ?? 0) + 1;
      // Day 07: first attempt throttles, retry succeeds.
      if (day === '07' && attemptsByDay[day] === 1) {
        return Promise.resolve(throttleResponse);
      }
      return Promise.resolve(candleResponse(`2026-05-${day}T09:15:00+05:30`));
    });

    const adapter = makeAdapter(getCandleData);
    const result = await adapter.getHistoricalData('12345', 'NSE', '15m', FROM, TO);

    // All 7 chunks present — the transient throttle was retried successfully.
    expect(result).toHaveLength(7);
    expect(attemptsByDay['07']).toBe(2); // throttled once, retried once
  });

  it('propagates a genuine non-throttle error without silently retrying it', async () => {
    const getCandleData = jest.fn().mockImplementation((params: any) => {
      const day = params.fromdate.slice(8, 10);
      if (day === '07') {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(candleResponse(`2026-05-${day}T09:15:00+05:30`));
    });

    const adapter = makeAdapter(getCandleData);
    // A genuine error is NOT an AngelThrottleError, so the chunk loop does not
    // swallow it and getHistoricalData's outer catch rethrows it.
    await expect(
      adapter.getHistoricalData('12345', 'NSE', '15m', FROM, TO),
    ).rejects.toThrow(/network down/);

    // The failing chunk is attempted exactly ONCE — no retries on a genuine
    // error. Chunks 04,05,06 ran once; 07 ran once and threw → 4 calls.
    expect(getCandleData).toHaveBeenCalledTimes(4);
  });

  it('still merges, dedupes and sorts a fully-successful multi-chunk fetch (no regression)', async () => {
    // Each chunk returns two rows in reverse order so the final sort is
    // exercised; timestamps are unique per chunk.
    const getCandleData = jest.fn().mockImplementation((params: any) => {
      const day = params.fromdate.slice(8, 10);
      return Promise.resolve({
        status: true,
        message: 'SUCCESS',
        data: [
          [`2026-05-${day}T15:30:00+05:30`, 1, 2, 0.5, 1.5, 50],
          [`2026-05-${day}T09:15:00+05:30`, 1, 2, 0.5, 1.5, 50],
        ],
      });
    });

    const adapter = makeAdapter(getCandleData);
    const result = await adapter.getHistoricalData('12345', 'NSE', '15m', FROM, TO);

    // 7 chunks × 2 unique bars = 14.
    expect(result).toHaveLength(14);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        result[i - 1].timestamp.getTime(),
      );
    }
    const seen = new Set(result.map((c) => c.timestamp.getTime()));
    expect(seen.size).toBe(result.length); // no duplicate timestamps
  });

  it('single-shot path: a persistent throttle propagates → getHistoricalData returns []', async () => {
    // 1d interval has a wide cap (1800d) so a 7-day range is a SINGLE call.
    // A persistent throttle there is retried then propagates; the outer catch
    // turns it into [].
    let calls = 0;
    const getCandleData = jest.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(throttleResponse);
    });
    const adapter = makeAdapter(getCandleData);
    const result = await adapter.getHistoricalData('12345', 'NSE', '1d', FROM, TO);

    expect(result).toEqual([]);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('single-shot path: a transient throttle is retried and recovers', async () => {
    let calls = 0;
    const getCandleData = jest.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(throttleResponse);
      return Promise.resolve(candleResponse('2026-05-05T09:15:00+05:30'));
    });
    const adapter = makeAdapter(getCandleData);
    const result = await adapter.getHistoricalData('12345', 'NSE', '1d', FROM, TO);

    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('exports AngelThrottleError as a named, instanceof-able error', () => {
    const e = new AngelThrottleError('x');
    expect(e).toBeInstanceOf(AngelThrottleError);
    expect(e.name).toBe('AngelThrottleError');
  });

  // ─── Rate-limit safety after removing the redundant per-chunk pacer ──────
  // FIX C: the auto-chunk loop no longer adds its own ~350ms sleep between
  // chunks. Pacing now comes SOLELY from `serializeHistoricalCall`, which
  // enforces a >=350ms gap between every historical call (3 req/sec cap).
  // These tests run on a VIRTUAL clock: `sleep(ms)` advances the clock by
  // `ms` and resolves instantly, and `Date.now()` reads that clock — so the
  // serialiser's real gap logic is exercised and we can assert timings.
  describe('historical-call pacing (3 req/sec safety, no double-pacing)', () => {
    function makePacedAdapter(getCandleData: jest.Mock) {
      const fakeAuth = {
        getSmartApi: () => ({ getCandleData }),
        isAuthenticated: () => true,
      } as unknown as AngelOneAuthService;
      const fakeWs = {
        on: jest.fn(),
        removeListener: jest.fn(),
      } as unknown as AngelOneWebSocketService;
      const adapter = new AngelOneAdapterService(fakeAuth, fakeWs);

      // Virtual clock shared by sleep + Date.now.
      let clock = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      const sleeps: number[] = [];
      jest.spyOn(adapter as any, 'sleep').mockImplementation((...args: unknown[]) => {
        const ms = args[0] as number;
        sleeps.push(ms);
        clock += ms; // advancing the clock makes the serialiser's gap real
        return Promise.resolve();
      });
      return { adapter, sleeps, getClock: () => clock };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Simulated wall-clock cost of one getCandleData round-trip. Picking a
    // value < 350ms is what makes single-source vs double pacing distinguish-
    // able: with one pacer the inter-call gap is exactly 350ms; the old
    // double-pacer (serialiser gap + a separate post-call chunk sleep) stacks
    // to ~350 + (350 - CALL_LATENCY) more, inflating each gap well past 350.
    const CALL_LATENCY_MS = 100;

    it('paces every chunk call exactly 350ms apart (3 req/sec) with NO double-pacing inflation', async () => {
      const callTimes: number[] = [];
      const { adapter, getClock } = makePacedAdapter(
        jest.fn().mockImplementation((params: any) => {
          callTimes.push(Date.now());
          // Model a non-zero round-trip: the call itself advances the clock.
          // (getClock closes over the same clock the sleep spy mutates.)
          void getClock;
          return new Promise((resolve) => {
            // Advance the virtual clock to simulate latency, then resolve.
            (adapter as any).sleep(CALL_LATENCY_MS).then(() => {
              const day = params.fromdate.slice(8, 10);
              resolve(candleResponse(`2026-05-${day}T09:15:00+05:30`));
            });
          });
        }),
      );

      // 7-day range, 15m interval → 7 one-day chunks → 7 calls.
      await adapter.getHistoricalData('12345', 'NSE', '15m', FROM, TO);
      expect(callTimes).toHaveLength(7);

      // 3 req/sec floor: every consecutive call is >=350ms apart.
      // Single-source ceiling: and NOT MORE than 350ms (+ the call's own
      // latency) — i.e. no extra stacked pacing. The old double-pacer would
      // push consecutive starts to ~450ms apart.
      for (let i = 1; i < callTimes.length; i++) {
        const gap = callTimes[i] - callTimes[i - 1];
        expect(gap).toBeGreaterThanOrEqual(350); // rate-limit safe (3 req/sec)
        // Single-source pacing fills each gap to EXACTLY 350ms. The old
        // double-pacer would inflate it to 350 + CALL_LATENCY_MS (= 450).
        expect(gap).toBe(350);
      }
    });
  });
});

/**
 * Cross-segment token collision (real-money bug).
 *
 * Angel One reuses the same numeric instrument token across segments —
 * e.g. token 7866 = NSE GVPIL (equity) AND CDS USDINR… (currency). The WS
 * tick cache and getLiveQuote/getLtpsBatch used to be keyed by TOKEN ALONE,
 * so a CDS tick could be served as the NSE price → phantom prices and fake
 * P&L. Every cache/lookup must now be keyed AND validated by
 * (exchange + token) so a tick from one segment can NEVER be returned for a
 * token request in another segment.
 */
describe('AngelOneAdapterService — cross-segment token collision', () => {
  /**
   * Build an adapter whose WS `on('tick')` listener we can drive, and whose
   * SmartAPI marketData is controllable. Returns the adapter plus an
   * `emitTick` helper that fires a tick at the adapter's registered handler.
   */
  function buildAdapter(marketDataMock?: jest.Mock) {
    let tickHandler: ((tick: TickData) => void) | null = null;
    const fakeAuth = {
      getSmartApi: () => ({ marketData: marketDataMock ?? jest.fn() }),
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn((event: string, cb: (t: TickData) => void) => {
        if (event === 'tick') tickHandler = cb;
      }),
      // subscribe is async and irrelevant to cache keying; resolve quietly.
      subscribe: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    const adapter = new AngelOneAdapterService(fakeAuth, fakeWs);
    return {
      adapter,
      emitTick: (tick: TickData) => {
        if (!tickHandler) throw new Error('adapter did not register a tick handler');
        tickHandler(tick);
      },
    };
  }

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
    // The WS feed annotates ticks with their segment; the adapter must honour it.
    if (exchange) t.exchange = exchange;
    return t as TickData;
  }

  it('(a) keeps two segments of the same token separate — never cross-contaminates', async () => {
    // REST returns nothing so getLiveQuote falls through to the WS cache.
    const marketData = jest.fn().mockResolvedValue({ status: false, data: { fetched: [] }, message: 'no data' });
    const { adapter, emitTick } = buildAdapter(marketData);

    // Token 7866 streams on BOTH segments at once.
    emitTick(tick('7866', 1054.0, 'CDS')); // USDINR-ish currency price
    emitTick(tick('7866', 12.5, 'NSE')); // GVPIL equity price

    const nse = await adapter.getLiveQuote('7866', 'NSE');
    const cds = await adapter.getLiveQuote('7866', 'CDS');

    expect(nse.ltp).toBe(12.5); // NSE request → NSE price, NOT the 1054 CDS tick
    expect(cds.ltp).toBe(1054.0);
  });

  it('(b) a token-only request never returns a foreign-segment tick', async () => {
    const marketData = jest.fn().mockResolvedValue({ status: false, data: { fetched: [] }, message: 'no data' });
    const { adapter, emitTick } = buildAdapter(marketData);

    // Only the CDS segment has ticked. An NSE-equity request for the same
    // token must NOT be served the CDS price — it should miss (throw), not
    // hand back the phantom 1054.
    emitTick(tick('7866', 1054.0, 'CDS'));

    await expect(adapter.getLiveQuote('7866', 'NSE')).rejects.toThrow();
  });

  it('logs a warning when the same token is seen under more than one segment', async () => {
    const { adapter, emitTick } = buildAdapter();
    const warn = jest.spyOn((adapter as any).logger, 'warn').mockImplementation(() => {});

    emitTick(tick('7866', 1054.0, 'CDS'));
    emitTick(tick('7866', 12.5, 'NSE'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7866'));
  });

  it('(c) getLtpsBatch ignores a response row from the wrong exchange', async () => {
    // We ask for NSE token 7866, but Angel returns BOTH an NSE row and a
    // foreign CDS row carrying the same token with a phantom price. Only the
    // NSE row may be admitted.
    const marketData = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          { symbolToken: '7866', exchange: 'NSE', ltp: 12.5 },
          { symbolToken: '7866', exchange: 'CDS', ltp: 1054.0 },
        ],
      },
    });
    const { adapter } = buildAdapter(marketData);

    const out = await adapter.getLtpsBatch('NSE', ['7866']);
    expect(out.get('7866')).toBe(12.5); // the NSE row, never the 1054 CDS row
  });

  it('getLtpsBatch still admits rows when the response omits an exchange field (back-compat)', async () => {
    // LTP-mode responses may not echo the exchange. Since we queried a single
    // exchange, an un-tagged row is assumed to belong to it.
    const marketData = jest.fn().mockResolvedValue({
      data: { fetched: [{ symbolToken: '2885', ltp: 2500 }] },
    });
    const { adapter } = buildAdapter(marketData);

    const out = await adapter.getLtpsBatch('NSE', ['2885']);
    expect(out.get('2885')).toBe(2500);
  });

  it('getLiveQuote prefers the fresh REST snapshot over the WS cache (no regression)', async () => {
    const marketData = jest.fn().mockResolvedValue({
      data: { fetched: [{ symbolToken: '2885', tradingSymbol: 'RELIANCE', ltp: 2500, open: 2490, high: 2510, low: 2480, close: 2495 }] },
    });
    const { adapter, emitTick } = buildAdapter(marketData);
    emitTick(tick('2885', 9999, 'NSE')); // stale WS tick that must be ignored

    const q = await adapter.getLiveQuote('2885', 'NSE');
    expect(q.ltp).toBe(2500); // REST wins
  });
});
