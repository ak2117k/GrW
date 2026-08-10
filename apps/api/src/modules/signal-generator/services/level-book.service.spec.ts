import { LevelBookService } from './level-book.service';

describe('LevelBookService', () => {
  let service: LevelBookService;

  beforeEach(() => {
    service = new LevelBookService();
  });

  // Helper: build a single daily candle
  const candle = (ts: string, o: number, h: number, l: number, c: number) => ({
    timestamp: new Date(ts),
    open: o, high: h, low: l, close: c, volume: 1000,
  });

  describe('seedSession', () => {
    it('seeds PDH/PDL/prevClose from the most recent candle', () => {
      service.seedSession({
        token: '99926000',
        symbol: 'NIFTY',
        exchange: 'NSE',
        recentDailyCandles: [
          candle('2026-04-25', 23900, 24050, 23800, 24020),
          candle('2026-04-26', 24020, 24180, 24000, 24100),
        ],
      });
      const lb = service.getLevels('99926000')!;
      expect(lb.pdh).toBe(24180);
      expect(lb.pdl).toBe(24000);
      expect(lb.prevClose).toBe(24100);
    });

    it('computes atr14 from the trailing 14 daily candles (Wilder)', () => {
      const candles = Array.from({ length: 14 }, (_, i) =>
        candle(`2026-04-${String(i + 1).padStart(2, '0')}`, 24000, 24100, 23900, 24050),
      );
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: candles,
      });
      const lb = service.getLevels('99926000')!;
      // All bars have range=200; SMA-of-TR = 200
      expect(lb.atr14).toBeCloseTo(200, 0);
    });

    it('initialises VWAP/today H/L to 0 and ORLocked=false', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      const lb = service.getLevels('99926000')!;
      expect(lb.vwap).toBe(0);
      expect(lb.todayHigh).toBe(0);
      expect(lb.todayLow).toBe(0);
      expect(lb.orh).toBeNull();
      expect(lb.orl).toBeNull();
      expect(lb.orLocked).toBe(false);
    });
  });

  describe('updateFromTick', () => {
    beforeEach(() => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
    });

    it('rolls VWAP across multiple ticks (volume-weighted)', () => {
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 24150, volume: 100, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      // (24100*100 + 24150*100) / 200 = 24125
      expect(lb.vwap).toBeCloseTo(24125, 1);
    });

    it('updates spot, todayHigh, todayLow', () => {
      service.updateFromTick({ token: '99926000', ltp: 24050, volume: 50, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 24200, volume: 50, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 23990, volume: 50, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      expect(lb.spot).toBe(23990);
      expect(lb.todayHigh).toBe(24200);
      expect(lb.todayLow).toBe(23990);
    });

    it('ignores ticks for tokens not yet seeded', () => {
      // No throw, no side effects
      expect(() =>
        service.updateFromTick({ token: 'unknown', ltp: 100, volume: 1, timestamp: new Date() }),
      ).not.toThrow();
      expect(service.getLevels('unknown')).toBeNull();
    });
  });

  describe('lockOpeningRange', () => {
    beforeEach(() => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
    });

    it('locks ORH/ORL from the supplied 15-min candle', () => {
      service.lockOpeningRange('99926000', { high: 24165, low: 24115 });
      const lb = service.getLevels('99926000')!;
      expect(lb.orh).toBe(24165);
      expect(lb.orl).toBe(24115);
      expect(lb.orLocked).toBe(true);
    });

    it('is idempotent — second call does not overwrite', () => {
      service.lockOpeningRange('99926000', { high: 24165, low: 24115 });
      service.lockOpeningRange('99926000', { high: 24999, low: 23999 });
      const lb = service.getLevels('99926000')!;
      expect(lb.orh).toBe(24165);
      expect(lb.orl).toBe(24115);
    });
  });

  describe('staleness', () => {
    it('marks level book stale when last tick > 60s old', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      const oldTickTime = new Date(Date.now() - 90_000);
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: oldTickTime });
      expect(service.isStale('99926000')).toBe(true);
    });

    it('marks fresh after a recent tick', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: new Date() });
      expect(service.isStale('99926000')).toBe(false);
    });
  });

  describe('roundNumbers', () => {
    it('returns nearest 50-step round numbers around spot for NIFTY', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 1, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      // Default round-step for NIFTY is 50; expect 24050, 24100, 24150 within ±100 of spot
      expect(lb.roundNumbers).toEqual(expect.arrayContaining([24050, 24100, 24150]));
    });
  });

  /**
   * The cron's seeding path had the same defect in a different shape: it fell
   * back a flat 24 hours before today's open, which from a Monday morning
   * lands on Sunday and replays nothing. Books seeded overnight therefore kept
   * VWAP=0 and spot=0 until the first live tick.
   */
  describe('replaySessionToBook', () => {
    /**
     * The clock is PINNED to 03:00 IST because the branch under test is the
     * overnight one. Left on the wall clock this passes at night and fails
     * during market hours — when `now >= today's open` the routine correctly
     * replays TODAY, and three-day-old fixture bars fall outside the window.
     * That is right behaviour and a wrong test, which is exactly how it first
     * showed up: green when written, red hours later with nothing changed.
     */
    beforeEach(() => {
      // 2026-08-10T21:30:00Z == 2026-08-11 03:00 IST — before that day's open.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-08-10T21:30:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('replays the last session that traded, not merely yesterday', async () => {
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      // Three days back — beyond a flat -24h reach, within the lookback.
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const bars = [201, 202, 203].map((close, i) => {
        const ist = Date.UTC(
          threeDaysAgo.getUTCFullYear(), threeDaysAgo.getUTCMonth(), threeDaysAgo.getUTCDate(),
          9, 15 + i * 5, 0, 0,
        );
        return {
          timestamp: new Date(ist - istOffsetMs),
          open: close, high: close + 1, low: close - 1, close,
          volume: BigInt(1000),
        };
      });

      const repo = {
        getCandles: jest.fn().mockImplementation(async (_id: string, _tf: string, from: Date, to: Date) =>
          bars.filter(
            (b) => b.timestamp.getTime() >= from.getTime() && b.timestamp.getTime() <= to.getTime(),
          ),
        ),
      } as any;
      const svc = new LevelBookService(undefined, repo);

      svc.seedSession({
        token: 'TKN_R', symbol: 'X', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 100, 110, 90, 105)],
      });
      await svc.replaySessionToBook('TKN_R', 'NSE', 'inst1');

      const book = svc.getLevels('TKN_R');
      expect(book!.spot).toBe(203);
      expect(book!.vwap).toBeGreaterThan(0);
    });
  });

  describe('lazyLoad', () => {
    const mkDaily = (offsetDays: number, h: number, l: number, c: number) => {
      const ts = new Date();
      ts.setUTCDate(ts.getUTCDate() - offsetDays);
      ts.setUTCHours(0, 0, 0, 0);
      return {
        timestamp: ts,
        open: c, high: h, low: l, close: c,
        volume: BigInt(1000),
      };
    };

    /**
     * The overnight/weekend gap.
     *
     * The 5m replay used to fetch `[today 09:15 IST, now]`. Before the open
     * that range is inverted and after a weekend it covers a day that never
     * traded, so it returned nothing, `updateFromTick` never ran, and the book
     * came back with spot / VWAP / today's H-L / OR all at their 0 seed — a
     * symbol that looks like it has never traded. The chart's trade plan then
     * had no price to anchor on and silently drew nothing.
     *
     * The bars here are two days old, so this window is empty whatever time of
     * day the suite runs — the test does not depend on a clock.
     */
    it('replays the most recent session when today has no bars yet', async () => {
      const dailyRows = Array.from({ length: 16 }, (_, i) =>
        mkDaily(16 - i, 110 + i, 90 + i, 100 + i),
      );
      // A prior session: 09:15, 09:20, 09:25 … IST two days back.
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const sessionBars = [101, 102, 103, 104].map((close, i) => {
        const ist = Date.UTC(
          twoDaysAgo.getUTCFullYear(), twoDaysAgo.getUTCMonth(), twoDaysAgo.getUTCDate(),
          9, 15 + i * 5, 0, 0,
        );
        return {
          timestamp: new Date(ist - istOffsetMs),
          open: close, high: close + 1, low: close - 1, close,
          volume: BigInt(1000),
        };
      });

      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      // Honest window semantics: return only rows inside [from, to].
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string, from: Date, to: Date) => {
            const rows = tf === '1d' ? dailyRows : sessionBars;
            return rows.filter(
              (r) => r.timestamp.getTime() >= from.getTime() && r.timestamp.getTime() <= to.getTime(),
            );
          },
        ),
      } as any;
      const svc = new LevelBookService(instrumentService, repo);

      const book = await svc.lazyLoad('TKN_ON', 'NSE', 'X');

      expect(book).not.toBeNull();
      // Last close of that session — a real price the trade plan can anchor on.
      expect(book!.spot).toBe(104);
      // The replay pushes each bar's CLOSE through updateFromTick, exactly as a
      // live tick would have arrived, so today's H/L track closes (104/101) —
      // not the bars' own extremes.
      expect(book!.todayHigh).toBe(104);
      expect(book!.todayLow).toBe(101);
      // OR comes from the first three bars of the SAME session.
      expect(book!.orh).toBe(104);
      expect(book!.orl).toBe(100);
    });

    /**
     * The lookback must never reach the BROKER.
     *
     * Angel returns empty for sub-hour intervals spanning a session boundary,
     * so 5m is capped at one day and the adapter chunks anything wider into
     * per-day calls — on a queue globally serialised at 350ms (3 req/sec) that
     * every other consumer shares. Routing an overnight 5-day lookback there
     * put five extra round trips in front of the chart's own candle fetches,
     * and the trend line, indicator card and S/R all went blank together.
     */
    it('never widens the 5m lookback onto the rate-limited broker path', async () => {
      const dailyRows = Array.from({ length: 16 }, (_, i) =>
        mkDaily(16 - i, 110 + i, 90 + i, 100 + i),
      );
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      // DB has daily candles but NO 5m bars at all — the case that used to fall
      // through to a five-chunk broker fetch.
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string) => (tf === '1d' ? dailyRows : []),
        ),
      } as any;
      const getHistoricalData = jest.fn().mockResolvedValue([]);
      const svc = new LevelBookService(instrumentService, repo, { getHistoricalData } as any);

      await svc.lazyLoad('TKN_RL', 'NSE', 'X');

      // Today's window may still consult the broker (one day, one call). The
      // widened lookback may not — so no 5m call may span more than a day.
      const fiveMinCalls = getHistoricalData.mock.calls.filter((c) => c[2] === '5m');
      for (const call of fiveMinCalls) {
        const spanMs = new Date(call[4]).getTime() - new Date(call[3]).getTime();
        expect(spanMs).toBeLessThanOrEqual(24 * 3600 * 1000);
      }
    });

    it('cache-hit returns existing book without DB call', async () => {
      const instrumentService = { getByToken: jest.fn() } as any;
      const repo = { getCandles: jest.fn() } as any;
      const svc = new LevelBookService(instrumentService, repo);

      svc.seedSession({
        token: 'TKN', symbol: 'X', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 100, 110, 90, 105)],
      });
      svc.updateFromTick({ token: 'TKN', ltp: 105, volume: 10, timestamp: new Date() });

      const book = await svc.lazyLoad('TKN', 'NSE', 'X');
      expect(book).not.toBeNull();
      expect(book!.symbol).toBe('X');
      expect(instrumentService.getByToken).not.toHaveBeenCalled();
      expect(repo.getCandles).not.toHaveBeenCalled();
    });

    it('cache-miss builds from mocked repo + instrument service', async () => {
      const dailyRows = Array.from({ length: 16 }, (_, i) =>
        mkDaily(16 - i, 110 + i, 90 + i, 100 + i),
      );
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string) =>
            tf === '1d' ? dailyRows : [],
        ),
      } as any;
      const svc = new LevelBookService(instrumentService, repo);

      const book = await svc.lazyLoad('TKN2', 'NSE', 'NIFTY');
      expect(book).not.toBeNull();
      expect(book!.pdh).toBe(125);
      expect(book!.pdl).toBe(105);
      expect(instrumentService.getByToken).toHaveBeenCalledWith('TKN2');
      expect(repo.getCandles).toHaveBeenCalled();
    });

    /**
     * The anchored level book (PDH/PDL/ORH/ORL/VWAP) is what a user most
     * expects to see drawn on the chart, and its broker fallback ran through
     * the SHARED Angel adapter — which has no feed account on this platform and
     * throws `Not authenticated` for every user-facing request. `lazyLoad` and
     * `refreshFromBroker` therefore take the caller's own candle source.
     */
    describe('per-request CandleSource', () => {
      const dailyRows = () =>
        Array.from({ length: 16 }, (_, i) => mkDaily(16 - i, 110 + i, 90 + i, 100 + i));

      it('builds the book from the source when the DB has nothing', async () => {
        const broker = { getHistoricalData: jest.fn().mockResolvedValue([]) } as any;
        const source = { getCandles: jest.fn().mockResolvedValue(dailyRows()) };
        const svc = new LevelBookService(undefined, undefined, broker);

        const book = await svc.lazyLoad('TKN', 'NSE', 'NIFTY', 'background', source as never);

        expect(book!.pdh).toBe(125);
        expect(source.getCandles).toHaveBeenCalled();
        // The adapter cannot authenticate for this request; it must not be the
        // thing the anchored levels depend on.
        expect(broker.getHistoricalData).not.toHaveBeenCalled();
      });

      it('falls back to the shared adapter when the source throws', async () => {
        const broker = {
          getHistoricalData: jest.fn().mockResolvedValue(dailyRows()),
        } as any;
        const source = { getCandles: jest.fn().mockRejectedValue(new Error('no session')) };
        const svc = new LevelBookService(undefined, undefined, broker);

        const book = await svc.lazyLoad('TKN', 'NSE', 'NIFTY', 'background', source as never);

        expect(book!.pdh).toBe(125);
        expect(broker.getHistoricalData).toHaveBeenCalled();
      });

      it('builds a book even with no adapter at all, given a source', async () => {
        // A container with no broker adapter used to be a guaranteed null book.
        const source = { getCandles: jest.fn().mockResolvedValue(dailyRows()) };
        const svc = new LevelBookService();

        const book = await svc.lazyLoad('TKN', 'NSE', 'NIFTY', 'background', source as never);

        expect(book).not.toBeNull();
        expect(book!.pdh).toBe(125);
      });

      it('regression: with NO source, the adapter is called exactly as before', async () => {
        const broker = { getHistoricalData: jest.fn().mockResolvedValue(dailyRows()) } as any;
        const svc = new LevelBookService(undefined, undefined, broker);

        await svc.lazyLoad('TKN', 'NSE', 'NIFTY');

        // Original arity and arguments — 'background' is the default priority
        // every existing caller relies on.
        expect(broker.getHistoricalData).toHaveBeenCalledWith(
          'TKN', 'NSE', '1d', expect.any(Date), expect.any(Date), 'background',
        );
      });

      it('refreshFromBroker uses the source, and still works with no adapter', async () => {
        const source = { getCandles: jest.fn().mockResolvedValue(dailyRows()) };
        const svc = new LevelBookService();

        const book = await svc.refreshFromBroker('TKN', 'NSE', 'NIFTY', source as never);

        expect(book).not.toBeNull();
        expect(source.getCandles).toHaveBeenCalledWith(
          'TKN', 'NSE', '1d', expect.any(Date), expect.any(Date),
        );
      });

      it('regression: refreshFromBroker with no source and no adapter is still null', async () => {
        const svc = new LevelBookService();
        await expect(svc.refreshFromBroker('TKN', 'NSE', 'NIFTY')).resolves.toBeNull();
      });
    });

    it('insufficient daily candles returns null', async () => {
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      const repo = {
        getCandles: jest.fn().mockResolvedValue([
          mkDaily(2, 110, 90, 100),
          mkDaily(1, 115, 95, 105),
        ]),
      } as any;
      const svc = new LevelBookService(instrumentService, repo);

      const book = await svc.lazyLoad('TKN3', 'NSE', 'X');
      expect(book).toBeNull();
    });
  });

  describe('lazyLoad → prevOrh/prevOrl (previous-session opening range)', () => {
    // 16 trailing daily candles so the seedSession ATR gate passes.
    const mkDaily = (offsetDays: number, h: number, l: number, c: number) => {
      const ts = new Date();
      ts.setUTCDate(ts.getUTCDate() - offsetDays);
      ts.setUTCHours(0, 0, 0, 0);
      return {
        timestamp: ts,
        open: c, high: h, low: l, close: c,
        volume: BigInt(1000),
      };
    };

    // 5m bar in the prev-session OR window (high/low only — that's what
    // computePrevSessionOR consumes).
    const mk5m = (h: number, l: number) => ({
      high: h, low: l, open: l, close: h, timestamp: new Date(), volume: BigInt(0),
    });

    const dailyRows = () =>
      Array.from({ length: 16 }, (_, i) => mkDaily(16 - i, 110 + i, 90 + i, 100 + i));

    it('populates prevOrh/prevOrl from 3 prior-day 5m bars in the DB', async () => {
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      // Repo answers: daily candles for the seed, 5m bars for today's session
      // (empty), then 5m bars for the prev-day OR window (3 bars).
      const fiveMinPrevDay = [mk5m(124, 118), mk5m(126, 119), mk5m(122, 117)];
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string, from: Date) => {
            if (tf === '1d') return dailyRows();
            if (tf === '5m') {
              // Today's session fetch starts at today's 09:15 IST. The
              // prev-day OR fetch starts at any earlier UTC. Distinguish
              // by relative time vs now.
              const now = Date.now();
              if (from.getTime() < now - 12 * 3600 * 1000) {
                return fiveMinPrevDay;
              }
              return [];
            }
            return [];
          },
        ),
      } as any;
      const svc = new LevelBookService(instrumentService, repo);

      const book = await svc.lazyLoad('TKN_P1', 'NSE', 'X');
      expect(book).not.toBeNull();
      expect(book!.prevOrh).toBe(126); // max(124, 126, 122)
      expect(book!.prevOrl).toBe(117); // min(118, 119, 117)
    });

    it('returns null prevOrh/prevOrl when no bars in 5-day lookback window', async () => {
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string) => (tf === '1d' ? dailyRows() : []),
        ),
      } as any;
      // No broker either — nothing returns 3 bars in any of the past 5 days.
      const svc = new LevelBookService(instrumentService, repo);

      const book = await svc.lazyLoad('TKN_P2', 'NSE', 'X');
      expect(book).not.toBeNull();
      expect(book!.prevOrh).toBeNull();
      expect(book!.prevOrl).toBeNull();
    });

    it('skips broker call when DB already has 3 prev-day bars (cost-saver)', async () => {
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      const fiveMinPrevDay = [mk5m(124, 118), mk5m(126, 119), mk5m(122, 117)];
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string, from: Date) => {
            if (tf === '1d') return dailyRows();
            if (tf === '5m') {
              const now = Date.now();
              if (from.getTime() < now - 12 * 3600 * 1000) {
                return fiveMinPrevDay; // First prev-day attempt finds 3 bars.
              }
              return [];
            }
            return [];
          },
        ),
      } as any;
      const brokerAdapter = {
        getHistoricalData: jest.fn().mockResolvedValue([]),
      } as any;
      const svc = new LevelBookService(instrumentService, repo, brokerAdapter);

      const book = await svc.lazyLoad('TKN_P3', 'NSE', 'X');
      expect(book).not.toBeNull();
      expect(book!.prevOrh).toBe(126);
      // Broker SHOULD still get called for the daily-candle fallback path
      // (fires when DB has < 14 daily) and the today-session 5m fallback
      // (DB had 0 bars). What it MUST NOT do is fire for the prev-day OR
      // walkback — i.e. there must be no 5m broker call with a `from`
      // older than ~12h ago when the DB already supplied the 3 bars.
      const prevDay5mBrokerCalls = brokerAdapter.getHistoricalData.mock.calls.filter(
        (args: any[]) => {
          const [, , tf, from] = args;
          if (tf !== '5m') return false;
          return (from as Date).getTime() < Date.now() - 12 * 3600 * 1000;
        },
      );
      expect(prevDay5mBrokerCalls.length).toBe(0);
    });

    it('falls back to broker when DB has 0 prev-day bars', async () => {
      const instrumentService = {
        getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }),
      } as any;
      const repo = {
        getCandles: jest.fn().mockImplementation(
          async (_id: string, tf: string) => (tf === '1d' ? dailyRows() : []),
        ),
      } as any;
      // Broker returns 3 bars on the very first prev-day attempt.
      const brokerAdapter = {
        getHistoricalData: jest.fn().mockImplementation(
          async (_t: string, _e: string, tf: string, from: Date) => {
            if (tf === '5m' && from.getTime() < Date.now() - 12 * 3600 * 1000) {
              return [
                { high: 130, low: 122, open: 122, close: 128, volume: 0, timestamp: from },
                { high: 132, low: 124, open: 128, close: 131, volume: 0, timestamp: from },
                { high: 129, low: 123, open: 131, close: 125, volume: 0, timestamp: from },
              ];
            }
            return [];
          },
        ),
      } as any;
      const svc = new LevelBookService(instrumentService, repo, brokerAdapter);

      const book = await svc.lazyLoad('TKN_P4', 'NSE', 'X');
      expect(book).not.toBeNull();
      expect(book!.prevOrh).toBe(132);
      expect(book!.prevOrl).toBe(122);
    });
  });
});
