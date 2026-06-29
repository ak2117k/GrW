import { TargetCalculatorService } from './target-calculator.service';

describe('TargetCalculatorService', () => {
  let svc: TargetCalculatorService;

  beforeEach(() => {
    svc = new TargetCalculatorService();
  });

  describe('BUY side', () => {
    it('picks closest in-range resistance above entry (range: [entry*1.005, entry*1.05])', () => {
      // entry=100: bounds=[100.5, 105]. PDH=104, ORH=103, VWAP+σ=101 all in range.
      // Closest (min) = 101.
      const r = svc.compute({
        side: 'BUY',
        entryPrice: 100,
        levelBook: { pdh: 104, pdl: 95, orh: 103, orl: 98, vwap: 100, vwapStddev: 1 },
      });
      expect(r.target).toBeCloseTo(101);
      expect(r.source).toBe('indicator-sr');
    });

    it('falls back to +2% when no level fits in range', () => {
      // entry=100: bounds=[100.5, 105]. PDH=200, ORH=250, VWAP+σ=151 all above 105 cap.
      const r = svc.compute({
        side: 'BUY',
        entryPrice: 100,
        levelBook: { pdh: 200, pdl: 95, orh: 250, orl: 98, vwap: 100, vwapStddev: 51 },
      });
      expect(r.target).toBeCloseTo(102);
      expect(r.source).toBe('fallback-2pct');
    });

    it('falls back when levelBook is null', () => {
      const r = svc.compute({ side: 'BUY', entryPrice: 100, levelBook: null });
      expect(r.target).toBeCloseTo(102);
      expect(r.source).toBe('fallback-2pct');
    });
  });

  describe('SELL side', () => {
    it('picks closest in-range support below entry (range: [entry*0.95, entry*0.995])', () => {
      // entry=100: bounds=[95, 99.5]. PDL=97, ORL=95, VWAP-σ=99 all in range.
      // Closest (max) = 99.
      const r = svc.compute({
        side: 'SELL',
        entryPrice: 100,
        levelBook: { pdh: 105, pdl: 97, orh: 103, orl: 95, vwap: 100, vwapStddev: 1 },
      });
      expect(r.target).toBeCloseTo(99);
      expect(r.source).toBe('indicator-sr');
    });

    it('falls back to -2% when no level fits in range', () => {
      // entry=100: bounds=[95, 99.5]. PDL=50, ORL=40, VWAP-σ=50 all below 95 floor.
      const r = svc.compute({
        side: 'SELL',
        entryPrice: 100,
        levelBook: { pdh: 105, pdl: 50, orh: 103, orl: 40, vwap: 100, vwapStddev: 50 },
      });
      expect(r.target).toBeCloseTo(98);
      expect(r.source).toBe('fallback-2pct');
    });

    it('falls back when levelBook is null', () => {
      const r = svc.compute({ side: 'SELL', entryPrice: 100, levelBook: null });
      expect(r.target).toBeCloseTo(98);
      expect(r.source).toBe('fallback-2pct');
    });
  });
});
