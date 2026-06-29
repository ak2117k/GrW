import { ema, rsi, macd, bollinger, roc, atr, supertrend, adx } from '../indicators';

describe('indicators', () => {
  describe('ema', () => {
    it('returns null for insufficient data', () => {
      expect(ema([1, 2], 3)).toBeNull();
      expect(ema([], 1)).toBeNull();
    });

    it('matches hand-calculated EMA-3 of [1,2,3,4,5]', () => {
      // SMA seed of first 3 = 2. k = 2/(3+1) = 0.5.
      // step 4: 4*0.5 + 2*0.5 = 3
      // step 5: 5*0.5 + 3*0.5 = 4
      expect(ema([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 6);
    });

    it('equals seed value when series length === period', () => {
      // EMA of exactly `period` values is just the SMA seed.
      expect(ema([10, 20, 30], 3)).toBeCloseTo(20, 6);
    });
  });

  describe('rsi', () => {
    it('returns null for insufficient data', () => {
      expect(rsi(Array(14).fill(100), 14)).toBeNull();
    });

    it('approaches 100 on a monotonic up sequence', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
      const r = rsi(closes, 14);
      expect(r).not.toBeNull();
      expect(r!).toBeGreaterThan(99);
    });

    it('approaches 0 on a monotonic down sequence', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
      const r = rsi(closes, 14);
      expect(r).not.toBeNull();
      expect(r!).toBeLessThan(1);
    });

    it('hovers around 50 on an oscillating sequence', () => {
      const closes: number[] = [];
      for (let i = 0; i < 60; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1));
      const r = rsi(closes, 14);
      expect(r).not.toBeNull();
      expect(r!).toBeGreaterThan(40);
      expect(r!).toBeLessThan(60);
    });
  });

  describe('macd', () => {
    it('returns null for insufficient data', () => {
      expect(macd(Array(20).fill(100))).toBeNull();
    });

    it('histogram is positive when an uptrend is accelerating', () => {
      // Flat then ramp: the MACD line rises, signal lags → positive hist.
      // (A pure linear ramp produces a constant MACD line and a histogram
      // that asymptotes to zero — pick a profile that's actually moving.)
      const closes: number[] = [];
      for (let i = 0; i < 50; i++) closes.push(100);
      for (let i = 0; i < 30; i++) closes.push(100 + i * 2);
      const m = macd(closes);
      expect(m).not.toBeNull();
      expect(m!.histogram).toBeGreaterThan(0);
    });

    it('histogram is negative when a downtrend is accelerating', () => {
      const closes: number[] = [];
      for (let i = 0; i < 50; i++) closes.push(200);
      for (let i = 0; i < 30; i++) closes.push(200 - i * 2);
      const m = macd(closes);
      expect(m).not.toBeNull();
      expect(m!.histogram).toBeLessThan(0);
    });
  });

  describe('bollinger', () => {
    it('returns null for insufficient data', () => {
      expect(bollinger([1, 2, 3], 20)).toBeNull();
    });

    it('middle band equals SMA, bands are symmetric', () => {
      const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
      const b = bollinger(closes, 20, 2);
      expect(b).not.toBeNull();
      expect(b!.middle).toBeCloseTo(10.5, 6); // SMA of 1..20
      const upDist = b!.upper - b!.middle;
      const downDist = b!.middle - b!.lower;
      expect(upDist).toBeCloseTo(downDist, 6);
      expect(upDist).toBeGreaterThan(0);
    });

    it('flat series collapses bands to middle', () => {
      const b = bollinger(Array(20).fill(100), 20, 2);
      expect(b!.upper).toBeCloseTo(100, 6);
      expect(b!.lower).toBeCloseTo(100, 6);
      expect(b!.middle).toBeCloseTo(100, 6);
    });
  });

  describe('roc', () => {
    it('returns null when series is shorter than period+1', () => {
      expect(roc([1, 2, 3], 10)).toBeNull();
    });

    it('computes simple two-point percentage change', () => {
      // closes[len-1] = 110, closes[len-1-period] = 100 → (10/100)*100 = 10
      const closes = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 110];
      expect(roc(closes, 10)).toBeCloseTo(10, 6);
    });

    it('returns negative for a drawdown', () => {
      const closes = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90];
      expect(roc(closes, 10)).toBeCloseTo(-10, 6);
    });
  });

  describe('atr', () => {
    it('returns null for insufficient candles', () => {
      expect(atr([1, 2], [0.5, 1], [0.8, 1.5], 14)).toBeNull();
    });

    it('computes ATR for a 14-bar rising series', () => {
      const n = 30;
      const h = Array.from({ length: n }, (_, i) => 100 + i);
      const l = Array.from({ length: n }, (_, i) => 99 + i);
      const c = Array.from({ length: n }, (_, i) => 99.5 + i);
      const v = atr(h, l, c, 14);
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThan(0);
      expect(v!).toBeLessThan(5); // small range, ATR should be modest
    });
  });

  describe('supertrend', () => {
    it('returns null for insufficient candles', () => {
      expect(supertrend([1, 2], [0.5, 1], [0.8, 1.5])).toBeNull();
    });

    it('reports UP direction for a strongly rising series', () => {
      const n = 30;
      const h = Array.from({ length: n }, (_, i) => 100 + i * 2);
      const l = Array.from({ length: n }, (_, i) => 99 + i * 2);
      const c = Array.from({ length: n }, (_, i) => 99.5 + i * 2);
      const r = supertrend(h, l, c, 10, 3);
      expect(r).not.toBeNull();
      expect(r!.direction).toBe('UP');
    });

    it('reports DOWN direction for a strongly falling series', () => {
      const n = 30;
      const h = Array.from({ length: n }, (_, i) => 200 - i * 2);
      const l = Array.from({ length: n }, (_, i) => 199 - i * 2);
      const c = Array.from({ length: n }, (_, i) => 199.5 - i * 2);
      const r = supertrend(h, l, c, 10, 3);
      expect(r).not.toBeNull();
      expect(r!.direction).toBe('DOWN');
    });
  });

  describe('adx', () => {
    it('returns null when highs.length < 2 * period + 1', () => {
      const period = 14;
      const n = 2 * period; // one short of the seed requirement
      const h = Array.from({ length: n }, (_, i) => 100 + i);
      const l = Array.from({ length: n }, (_, i) => 99 + i);
      const c = Array.from({ length: n }, (_, i) => 99.5 + i);
      expect(adx(h, l, c, period)).toBeNull();
    });

    it('returns null when arrays have mismatched lengths', () => {
      const h = Array.from({ length: 30 }, (_, i) => 100 + i);
      const l = Array.from({ length: 29 }, (_, i) => 99 + i);
      const c = Array.from({ length: 30 }, (_, i) => 99.5 + i);
      expect(adx(h, l, c, 14)).toBeNull();
    });

    it('reports ADX > 25 on a strong uptrend (200 monotonically rising bars)', () => {
      const n = 200;
      const h = Array.from({ length: n }, (_, i) => 100 + i);
      const l = Array.from({ length: n }, (_, i) => 99 + i);
      const c = Array.from({ length: n }, (_, i) => 99.5 + i);
      const v = adx(h, l, c, 14);
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThan(25);
    });

    it('reports ADX < 25 on a flat/choppy series', () => {
      const n = 200;
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = i % 2 === 0 ? 100 : 100.5;
        closes.push(c);
        highs.push(c + 0.1);
        lows.push(c - 0.1);
      }
      const v = adx(highs, lows, closes, 14);
      expect(v).not.toBeNull();
      expect(v!).toBeLessThan(25);
    });

    it('is pure — same input yields same output', () => {
      const n = 60;
      const h = Array.from({ length: n }, (_, i) => 100 + i * 0.5);
      const l = Array.from({ length: n }, (_, i) => 99 + i * 0.5);
      const c = Array.from({ length: n }, (_, i) => 99.5 + i * 0.5);
      const a = adx(h, l, c, 14);
      const b = adx(h, l, c, 14);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!).toBe(b!);
      // Inputs must not have been mutated.
      expect(h.length).toBe(n);
      expect(l.length).toBe(n);
      expect(c.length).toBe(n);
    });
  });
});
