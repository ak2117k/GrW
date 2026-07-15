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
     * Anchor at bar 20 of the rising fixture, entry = close@20 = 120.
     *
     * `atrAtDetection` is deliberately 2, NOT the 3 that recomputing ATR(14)
     * over this fixture would yield: the resolver must label against the number
     * the row stored at capture, not one derived from the resolve window. So
     * favorable = 120 + 1.5*2 = 123 and adverse = 120 - 1*2 = 118, and bar 21's
     * high (123) clears the favorable level → WIN.
     */
    const bullishPending = {
      id: 'p1', token: '2885', exchange: 'NSE', timeframe: '15m',
      barTime: new Date(20 * 1000), bias: 'BULLISH', atrAtDetection: 2,
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

    // Must be 'bulk', not 'background'. The adapter's cache key ignores
    // [from,to], so a background read here would be served whatever short
    // window a live scan last cached (losing the anchor bar), and a background
    // write would publish this window to live consumers under the shared key.
    it('fetches history on the bulk priority lane (cache-bypassing)', async () => {
      const repo = pendingRepo([bullishPending]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      await svc.resolvePending(10);

      expect(adapter.getHistoricalData).toHaveBeenCalledWith(
        '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'bulk',
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

      // Short from 120: adverse = 120 + 1*2 = 122, hit by bar 21's high (123)
      // before the favorable 117 could ever print in a rising market.
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

    // The two tests below are the point of labeling against the stored ATR:
    // each pins an outcome that a resolver recomputing ATR from its own window
    // could not produce. Together they bracket the behaviour from both sides —
    // one resolves where a recompute would skip, one holds where a recompute
    // would resolve.

    // Anchor 5 leaves only 6 bars of history inside the resolve window, so a
    // recomputed ATR(14) would be 0 (computeAtrFromCandles needs > period bars)
    // and the row would be skipped — forever, since the window start advances
    // with the row. The row already carries a good ATR from its capture window,
    // so it labels fine: entry = close@5 = 105, favorable = 105 + 1.5*2 = 108,
    // adverse = 103; bar 6's high (108) clears favorable → WIN.
    it('labels an anchor near the window start against the stored ATR', async () => {
      const repo = pendingRepo([{ ...bullishPending, barTime: new Date(5 * 1000) }]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      expect(n).toBe(1);
      expect(repo.updateOutcome).toHaveBeenCalledWith('p1', 'WIN', 1);
    });

    // Mirror of the above. A stored ATR of 10 puts favorable at 120 + 1.5*10 =
    // 135 and adverse at 110 — neither printed by bar 29 (max high 131, min low
    // 120), and the 10-bar horizon runs past the fixture, so the row stays
    // PENDING. A resolver recomputing ATR = 3 off this window would instead see
    // favorable = 124.5, call bar 23's high (125) a WIN, and finalize the row
    // against a yardstick it never stored.
    it('holds a row PENDING when the stored ATR puts both levels out of reach', async () => {
      const repo = pendingRepo([{ ...bullishPending, atrAtDetection: 10 }]);
      const adapter = {
        getHistoricalData: jest.fn().mockResolvedValue(asHistorical(rising(30))),
      } as any;
      const svc = new PatternCaptureService(adapter, repo);

      const n = await svc.resolvePending(10);

      expect(n).toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
    });

    it('flat candles produce no capture rows (ATR is zero)', async () => {
      const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
      const svc = new PatternCaptureService({} as any, repo);

      await expect(svc.capture(flat(30), [marker], meta)).resolves.toBe(0);
    });
  });
});
