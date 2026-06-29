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
