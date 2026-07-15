import { PatternCaptureService } from './pattern-capture.service';
import type { OhlcvCandle } from './pattern-observation.types';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

function flat(n: number): OhlcvCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 1000, open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

/**
 * Rising fixture: every bar's true range is exactly 3 (high-low = 3,
 * |high-prevClose| = 3, |low-prevClose| = 0), so ATR(14) = 3 at any anchor
 * with more than 14 bars of history behind it.
 */
function rising(n: number): OhlcvCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 1000, open: 100 + i, high: 102 + i, low: 99 + i, close: 100 + i, volume: 10,
  }));
}

function asHistorical(candles: OhlcvCandle[]) {
  return candles.map((c) => ({
    timestamp: new Date(c.time),
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
}

const marker: PatternMarkerDto = {
  category: 'CANDLESTICK', name: 'HAMMER', bias: 'BULLISH',
  time: 20 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
};

const meta = { token: '2885', exchange: 'NSE', timeframe: '15m' };

describe('PatternCaptureService', () => {
  describe('capture', () => {
    it('saves observations and returns the count', async () => {
      const repo = {
        saveMany: jest.fn().mockResolvedValue(1),
        findPending: jest.fn(),
        updateOutcome: jest.fn(),
      } as any;
      const svc = new PatternCaptureService({} as any, repo);

      const n = await svc.capture(rising(30), [marker], meta);

      expect(n).toBe(1);
      expect(repo.saveMany).toHaveBeenCalledTimes(1);
      // Pins that the assembler output actually reaches the repo — a capture that
      // saved an empty array would still return 1 from the mock above.
      const saved = repo.saveMany.mock.calls[0][0];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual(
        expect.objectContaining({
          token: '2885',
          exchange: 'NSE',
          timeframe: '15m',
          patternName: 'HAMMER',
          bias: 'BULLISH',
          barTime: new Date(20 * 1000),
        }),
      );
    });

    it('never throws — returns 0 if the repo fails (fail-open)', async () => {
      const repo = { saveMany: jest.fn().mockRejectedValue(new Error('db down')) } as any;
      const svc = new PatternCaptureService({} as any, repo);

      await expect(svc.capture(rising(30), [marker], meta)).resolves.toBe(0);
    });

    it('never throws — returns 0 if the assembler is handed garbage (fail-open)', async () => {
      const repo = { saveMany: jest.fn().mockResolvedValue(1) } as any;
      const svc = new PatternCaptureService({} as any, repo);

      await expect(svc.capture(null as any, [marker], meta)).resolves.toBe(0);
      expect(repo.saveMany).not.toHaveBeenCalled();
    });
  });

  describe('resolvePending', () => {
    function pendingRepo(rows: any[]) {
      return {
        findPending: jest.fn().mockResolvedValue(rows),
        updateOutcome: jest.fn().mockResolvedValue(undefined),
      } as any;
    }

    /**
     * Anchor at bar 20 of the rising fixture: ATR = 3, entry = close@20 = 120,
     * favorable = 120 + 1.5*3 = 124.5, adverse = 120 - 1*3 = 117. Bar 23's high
     * (125) clears the favorable level first → WIN.
     */
    const bullishPending = {
      id: 'p1', token: '2885', exchange: 'NSE', timeframe: '15m',
      barTime: new Date(20 * 1000), bias: 'BULLISH',
    };

    it('finalizes a row whose horizon has now resolved', async () => {
      const repo = pendingRepo([bullishPending]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      expect(n).toBe(1);
      expect(repo.updateOutcome).toHaveBeenCalledWith('p1', 'WIN', 1);
    });

    it('fetches history on the background priority lane', async () => {
      const repo = pendingRepo([bullishPending]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      await svc.resolvePending(10);

      expect(adapter.getHistoricalData).toHaveBeenCalledWith(
        '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'background',
      );
    });

    // The stored bias is the ONLY source of direction at resolve time — the row
    // already committed to one at capture. A resolver that ignored `bias` and
    // always went long would report WIN here instead of LOSS.
    it('reads the direction from the stored bias', async () => {
      const repo = pendingRepo([{ ...bullishPending, bias: 'BEARISH' }]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      // Short from 120: adverse = 120 + 3 = 123, hit by bar 21's high (123) before
      // the favorable 115.5 could ever print in a rising market.
      expect(n).toBe(1);
      expect(repo.updateOutcome).toHaveBeenCalledWith('p1', 'LOSS', 0);
    });

    it('leaves a row alone when its horizon is still unresolved', async () => {
      const repo = pendingRepo([bullishPending]);
      // Truncated at bar 22 — neither level hit and the 10-bar horizon isn't
      // complete, so the outcome is still PENDING.
      const truncated = rising(30).slice(0, 23).map((c) => ({ ...c, high: 121, low: 119, close: 120 }));
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(truncated)),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      expect(n).toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
    });

    it('skips a row whose anchor bar is missing from the fetched history', async () => {
      const repo = pendingRepo([{ ...bullishPending, barTime: new Date(999 * 1000) }]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      await expect(svc.resolvePending(10)).resolves.toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
    });

    it('one failing row does not abort the rest', async () => {
      const repo = pendingRepo([
        { ...bullishPending, id: 'bad' },
        { ...bullishPending, id: 'good' },
      ]);
      const adapter = {
        getHistoricalData: jest
          .fn()
          .mockRejectedValueOnce(new Error('angel timeout'))
          .mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      expect(n).toBe(1);
      expect(repo.updateOutcome).toHaveBeenCalledWith('good', 'WIN', 1);
    });

    it('returns 0 when findPending itself fails', async () => {
      const repo = { findPending: jest.fn().mockRejectedValue(new Error('db down')) } as any;
      const svc = new PatternCaptureService({} as any, repo);

      await expect(svc.resolvePending(10)).resolves.toBe(0);
    });

    it('skips a row with too little history to compute an ATR', async () => {
      const repo = pendingRepo([{ ...bullishPending, barTime: new Date(5 * 1000) }]);
      // Anchor 5 → only 6 bars behind it → ATR(14) = 0 → cannot scale a target.
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      await expect(svc.resolvePending(10)).resolves.toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
    });

    it('flat candles produce no capture rows (ATR is zero)', async () => {
      const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
      const svc = new PatternCaptureService({} as any, repo);

      await expect(svc.capture(flat(30), [marker], meta)).resolves.toBe(0);
    });
  });
});
