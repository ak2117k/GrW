import { DetectionContextService } from './detection-context.service';
import type { LevelBook } from '../types/level-book.types';

/**
 * A fully-populated LevelBook with everything zeroed/nulled by default so each
 * test can opt IN to exactly the S/R levels it wants to price against — a level
 * left at 0 / null is filtered out as "not populated" by the service, so it
 * never accidentally becomes the nearest level.
 */
function levelBook(partial: Partial<LevelBook>): LevelBook {
  return {
    token: '2885', symbol: 'RELIANCE', exchange: 'NSE', asOf: new Date(0),
    pdh: 0, pdl: 0, prevClose: 0, orh: null, orl: null, orLocked: false,
    prevOrh: null, prevOrl: null, spot: 0, vwap: 0, todayHigh: 0, todayLow: 0,
    atr14: 0, lastTickAt: new Date(0), roundNumbers: [],
    ...partial,
  };
}

/** 15m candle series carrying only the closes that classifyTrend reads. */
function candles(closes: number[]) {
  return closes.map((c, i) => ({
    timestamp: new Date(i * 1000), open: c, high: c, low: c, close: c, volume: 10,
  }));
}
// Strictly rising / falling over >26 bars → classifyTrend UP / DOWN; flat →
// INDETERMINATE (which the service normalises to NEUTRAL).
const rising = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
const falling = candles(Array.from({ length: 60 }, (_, i) => 300 - i));
const flat = candles(Array.from({ length: 60 }, () => 100));

function makeMocks() {
  return {
    mtf: {
      check: jest.fn().mockResolvedValue({
        aligned: true, agreedDirection: 'UP', directions: {}, summary: '',
      }),
    },
    levelBook: {
      // Nearest populated level (pdh=105, vwap=95) sits 5 away from spot=100;
      // with atr=10 that is 0.5 ATR — right on the atLevel threshold.
      lazyLoad: jest.fn().mockResolvedValue(
        levelBook({ pdh: 105, pdl: 80, prevClose: 90, vwap: 95 }),
      ),
    },
    nseSector: { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926009') },
    adapter: { getHistoricalData: jest.fn().mockResolvedValue(rising) },
  };
}

function makeSvc(m = makeMocks()) {
  const svc = new DetectionContextService(
    m.mtf as any, m.levelBook as any, m.nseSector as any, m.adapter as any,
  );
  return { svc, ...m };
}

const input = {
  token: '2885', exchange: 'NSE', symbol: 'RELIANCE',
  bias: 'BULLISH' as const, spot: 100, atr: 10,
};

describe('DetectionContextService', () => {
  describe('compute — happy path', () => {
    it('assembles the versioned snapshot from all three sub-signals', async () => {
      const { svc } = makeSvc();

      const ctx = await svc.compute(input);

      expect(ctx).toEqual({
        v: 1,
        mtf: { aligned: true, direction: 'UP' },
        sr: { distanceAtr: 0.5, atLevel: true },
        sector: { trend: 'UP', alignment: 'with' },
      });
    });

    it('loads the level book on the bulk lane (cache-safe, mirrors backfill)', async () => {
      const { svc, levelBook: lb } = makeSvc();

      await svc.compute(input);

      expect(lb.lazyLoad).toHaveBeenCalledWith('2885', 'NSE', 'RELIANCE', 'bulk');
    });
  });

  describe('per-signal fail-open — one service down never nulls the whole snapshot', () => {
    it('mtf throws → mtf null, sr + sector intact', async () => {
      const m = makeMocks();
      m.mtf.check.mockRejectedValue(new Error('mtf down'));
      const { svc } = makeSvc(m);

      const ctx = await svc.compute(input);

      expect(ctx.mtf).toBeNull();
      expect(ctx.sr).toEqual({ distanceAtr: 0.5, atLevel: true });
      expect(ctx.sector).toEqual({ trend: 'UP', alignment: 'with' });
    });

    it('level book throws → sr null, mtf + sector intact', async () => {
      const m = makeMocks();
      m.levelBook.lazyLoad.mockRejectedValue(new Error('book down'));
      const { svc } = makeSvc(m);

      const ctx = await svc.compute(input);

      expect(ctx.sr).toBeNull();
      expect(ctx.mtf).toEqual({ aligned: true, direction: 'UP' });
      expect(ctx.sector).toEqual({ trend: 'UP', alignment: 'with' });
    });

    it('sector fetch throws → sector null, mtf + sr intact', async () => {
      const m = makeMocks();
      m.adapter.getHistoricalData.mockRejectedValue(new Error('angel timeout'));
      const { svc } = makeSvc(m);

      const ctx = await svc.compute(input);

      expect(ctx.sector).toBeNull();
      expect(ctx.mtf).toEqual({ aligned: true, direction: 'UP' });
      expect(ctx.sr).toEqual({ distanceAtr: 0.5, atLevel: true });
    });
  });

  describe('sector alignment vs bias', () => {
    it('BULLISH bias + UP sector trend → with', async () => {
      const m = makeMocks();
      m.adapter.getHistoricalData.mockResolvedValue(rising);
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, bias: 'BULLISH' });

      expect(ctx.sector).toEqual({ trend: 'UP', alignment: 'with' });
    });

    it('BULLISH bias + DOWN sector trend → against', async () => {
      const m = makeMocks();
      m.adapter.getHistoricalData.mockResolvedValue(falling);
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, bias: 'BULLISH' });

      expect(ctx.sector).toEqual({ trend: 'DOWN', alignment: 'against' });
    });

    it('an INDETERMINATE trend maps to NEUTRAL/neutral regardless of bias', async () => {
      const m = makeMocks();
      m.adapter.getHistoricalData.mockResolvedValue(flat);
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, bias: 'BULLISH' });

      expect(ctx.sector).toEqual({ trend: 'NEUTRAL', alignment: 'neutral' });
    });

    it('no sector mapping → sector null (no candle fetch attempted)', async () => {
      const m = makeMocks();
      m.nseSector.getSectorIndexForSymbol.mockResolvedValue(null);
      const { svc } = makeSvc(m);

      const ctx = await svc.compute(input);

      expect(ctx.sector).toBeNull();
      expect(m.adapter.getHistoricalData).not.toHaveBeenCalled();
    });
  });

  describe('S/R distance is in ATR units and honours the 0.5 threshold', () => {
    it('nearest level 3 rupees away with atr 6 → 0.5 ATR → atLevel', async () => {
      const m = makeMocks();
      m.levelBook.lazyLoad.mockResolvedValue(levelBook({ pdh: 103, pdl: 50 }));
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, spot: 100, atr: 6 });

      expect(ctx.sr).toEqual({ distanceAtr: 0.5, atLevel: true });
    });

    it('nearest level 8 rupees away with atr 10 → 0.8 ATR → not atLevel', async () => {
      const m = makeMocks();
      m.levelBook.lazyLoad.mockResolvedValue(levelBook({ pdh: 108, pdl: 50 }));
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, spot: 100, atr: 10 });

      expect(ctx.sr).toEqual({ distanceAtr: 0.8, atLevel: false });
    });

    it('atr <= 0 → sr null (division would be meaningless); book not even loaded', async () => {
      const m = makeMocks();
      const { svc } = makeSvc(m);

      const ctx = await svc.compute({ ...input, atr: 0 });

      expect(ctx.sr).toBeNull();
      expect(m.levelBook.lazyLoad).not.toHaveBeenCalled();
    });

    it('null book → sr null', async () => {
      const m = makeMocks();
      m.levelBook.lazyLoad.mockResolvedValue(null);
      const { svc } = makeSvc(m);

      const ctx = await svc.compute(input);

      expect(ctx.sr).toBeNull();
    });
  });
});
