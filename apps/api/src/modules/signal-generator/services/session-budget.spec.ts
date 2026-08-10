import { sessionBudget } from './session-budget';

/**
 * Every `now` here is built from an explicit UTC instant so the suite reads the
 * same on a CI box in UTC and a laptop in IST. `ist(12, 44)` is the 12:44 IST
 * of the spec's §0.3 incident.
 */
const ist = (h: number, m = 0): Date => {
  const totalMin = h * 60 + m - 5 * 60 - 30; // IST → UTC
  return new Date(Date.UTC(2026, 7, 10, 0, 0, 0) + totalMin * 60 * 1000);
};

/** A plausible low-volatility NIFTY day: 200-point daily ATR. */
const ATR = 200;

describe('sessionBudget', () => {
  describe('the §0.3 incident', () => {
    it('caps a 113-point projection at 12:44 IST on a mostly-spent low-vol day', () => {
      const b = sessionBudget({
        now: ist(12, 44),
        exchange: 'NSE',
        dailyAtr: ATR,
        // 180 of the 200-point ATR already travelled: 0.9x consumed.
        todayHigh: 24_700,
        todayLow: 24_520,
      });

      expect(b.rangeConsumedAtr).toBeCloseTo(0.9, 4);
      expect(b.sessionFractionLeft).toBeCloseTo(166 / 375, 3);
      expect(b.points).not.toBeNull();
      // The whole point of the module: 113 must not survive this.
      expect(b.points as number).toBeLessThan(113);
      // Floored by RESIDUAL_EXPANSION_ATR (0.25), not by (1 − 0.9) = 0.1.
      expect(b.points).toBeCloseTo(ATR * (166 / 375) * 0.25, 1);
    });
  });

  describe('null means "cannot say", never 0', () => {
    it('returns null points when the daily ATR is missing', () => {
      const b = sessionBudget({
        now: ist(12, 0),
        exchange: 'NSE',
        dailyAtr: null,
        todayHigh: 24_700,
        todayLow: 24_520,
      });

      expect(b.points).toBeNull();
      expect(b.points).not.toBe(0);
      expect(b.rangeConsumedAtr).toBeNull();
      // The session itself is still measurable without an ATR.
      expect(b.sessionFractionLeft).toBeGreaterThan(0);
      expect(b.reason).toMatch(/no daily atr/i);
    });

    it.each([0, -5, NaN, Infinity])('treats a non-positive/non-finite ATR (%p) as absent', (atr) => {
      const b = sessionBudget({
        now: ist(12, 0),
        exchange: 'NSE',
        dailyAtr: atr,
        todayHigh: 24_700,
        todayLow: 24_520,
      });
      expect(b.points).toBeNull();
    });

    it("returns null points when today's high/low are missing", () => {
      const b = sessionBudget({
        now: ist(12, 0),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: null,
        todayLow: null,
      });

      expect(b.points).toBeNull();
      expect(b.rangeConsumedAtr).toBeNull();
      expect(b.reason).toMatch(/high and low/i);
    });

    it('refuses to measure a corrupt book where the high is below the low', () => {
      const b = sessionBudget({
        now: ist(12, 0),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_520,
        todayLow: 24_700,
      });

      expect(b.points).toBeNull();
      expect(b.rangeConsumedAtr).toBeNull();
    });

    it('reports an unreadable clock as unknown, not as a closed session', () => {
      const b = sessionBudget({
        now: new Date('nonsense'),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_700,
        todayLow: 24_520,
      });

      expect(b.points).toBeNull();
      expect(b.reason).toMatch(/unreadable/i);
    });
  });

  describe('session boundaries', () => {
    it('gives the full session ahead before the open', () => {
      const b = sessionBudget({
        now: ist(8, 30),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_600,
        todayLow: 24_600, // nothing traded yet
      });

      expect(b.sessionFractionLeft).toBe(1);
      expect(b.rangeConsumedAtr).toBe(0);
      expect(b.points).toBeCloseTo(ATR, 2);
    });

    it('yields 0 points with a stated reason once the session is over', () => {
      const b = sessionBudget({
        now: ist(15, 45),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_700,
        todayLow: 24_520,
      });

      expect(b.sessionFractionLeft).toBe(0);
      expect(b.points).toBe(0); // a measurement, not an absence
      expect(b.reason).toMatch(/session is over/i);
      expect(b.reason).toContain('15:30');
    });

    it('says the session is over even without an ATR — no more day is knowable', () => {
      const b = sessionBudget({
        now: ist(16, 0),
        exchange: 'NSE',
        dailyAtr: null,
        todayHigh: null,
        todayLow: null,
      });

      expect(b.points).toBe(0);
      expect(b.reason).toMatch(/session is over/i);
    });

    it('is exactly 0 at the closing bell and positive one minute before', () => {
      const base = { exchange: 'NSE', dailyAtr: ATR, todayHigh: 24_700, todayLow: 24_520 };
      expect(sessionBudget({ ...base, now: ist(15, 30) }).sessionFractionLeft).toBe(0);
      expect(sessionBudget({ ...base, now: ist(15, 29) }).sessionFractionLeft).toBeGreaterThan(0);
    });
  });

  describe('exchange hours', () => {
    const base = { dailyAtr: ATR, todayHigh: 24_700, todayLow: 24_520 };

    it('closes NSE/BSE at 15:30 while MCX is still mid-session', () => {
      const at1600 = ist(16, 0);
      const nse = sessionBudget({ ...base, now: at1600, exchange: 'NSE' });
      const bse = sessionBudget({ ...base, now: at1600, exchange: 'BSE' });
      const mcx = sessionBudget({ ...base, now: at1600, exchange: 'MCX' });

      expect(nse.sessionFractionLeft).toBe(0);
      expect(nse.points).toBe(0);
      expect(bse.sessionFractionLeft).toBe(0);

      // MCX runs to 23:30: 450 of its 870 minutes remain.
      expect(mcx.sessionFractionLeft).toBeCloseTo(450 / 870, 3);
      expect(mcx.points as number).toBeGreaterThan(0);
      expect(mcx.reason).toContain('23:30');
    });

    it('opens MCX at 09:00, fifteen minutes before the equity session', () => {
      const at0905 = ist(9, 5);
      expect(sessionBudget({ ...base, now: at0905, exchange: 'NSE' }).sessionFractionLeft).toBe(1);
      expect(
        sessionBudget({ ...base, now: at0905, exchange: 'MCX' }).sessionFractionLeft,
      ).toBeLessThan(1);
    });

    it('closes MCX after 23:30', () => {
      const b = sessionBudget({ ...base, now: ist(23, 45), exchange: 'MCX' });
      expect(b.sessionFractionLeft).toBe(0);
      expect(b.points).toBe(0);
    });

    it('falls back to equity hours for an unrecognised exchange', () => {
      const at1600 = ist(16, 0);
      expect(sessionBudget({ ...base, now: at1600, exchange: 'NFO' }).sessionFractionLeft).toBe(0);
      expect(sessionBudget({ ...base, now: at1600, exchange: '' }).sessionFractionLeft).toBe(0);
    });

    it('is case- and whitespace-insensitive about MCX', () => {
      const b = sessionBudget({ ...base, now: ist(16, 0), exchange: ' mcx ' });
      expect(b.sessionFractionLeft).toBeGreaterThan(0);
    });
  });

  describe('range mean-reversion', () => {
    const at1230 = ist(12, 30);

    it('gives a mostly-spent day materially less budget than a barely-moved one', () => {
      const spent = sessionBudget({
        now: at1230,
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_700,
        todayLow: 24_530, // 0.85x ATR consumed
      });
      const fresh = sessionBudget({
        now: at1230,
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_600,
        todayLow: 24_540, // 0.30x ATR consumed
      });

      expect(spent.points as number).toBeLessThan(fresh.points as number);
      // "Materially", not marginally: less than half.
      expect(spent.points as number).toBeLessThan((fresh.points as number) / 2);
    });

    it('never grants MORE budget for MORE range consumed', () => {
      const budgets = [0, 40, 80, 120, 160, 200, 300, 400].map(
        (range) =>
          sessionBudget({
            now: at1230,
            exchange: 'NSE',
            dailyAtr: ATR,
            todayHigh: 24_500 + range,
            todayLow: 24_500,
          }).points as number,
      );

      for (let i = 1; i < budgets.length; i += 1) {
        expect(budgets[i]).toBeLessThanOrEqual(budgets[i - 1]);
      }
    });

    it('floors a day that has already blown through its ATR, rather than zeroing it', () => {
      const b = sessionBudget({
        now: at1230,
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_800,
        todayLow: 24_500, // 1.5x ATR — well past a typical day
      });

      expect(b.rangeConsumedAtr).toBeCloseTo(1.5, 4);
      expect(b.points as number).toBeGreaterThan(0);
      expect(b.points).toBeCloseTo(ATR * b.sessionFractionLeft * 0.25, 1);
    });

    it('scales with the daily ATR — a wide-range symbol gets a wider budget', () => {
      const args = { now: at1230, exchange: 'NSE', todayHigh: 24_560, todayLow: 24_500 };
      const calm = sessionBudget({ ...args, dailyAtr: 100 });
      const wild = sessionBudget({ ...args, dailyAtr: 400 });
      expect(wild.points as number).toBeGreaterThan(calm.points as number);
    });
  });

  describe('ordering: more time left never yields less budget', () => {
    it('is monotonically non-increasing through the equity session', () => {
      const clocks: Array<[number, number]> = [
        [9, 15],
        [10, 0],
        [11, 30],
        [12, 44],
        [14, 0],
        [15, 0],
        [15, 29],
        [15, 30],
      ];

      const budgets = clocks.map(
        ([h, m]) =>
          sessionBudget({
            now: ist(h, m),
            exchange: 'NSE',
            dailyAtr: ATR,
            todayHigh: 24_650,
            todayLow: 24_520,
          }).points as number,
      );

      for (let i = 1; i < budgets.length; i += 1) {
        expect(budgets[i]).toBeLessThanOrEqual(budgets[i - 1]);
      }
      expect(budgets[budgets.length - 1]).toBe(0);
    });

    it('holds for MCX too, across its evening session', () => {
      const budgets = [10, 14, 18, 21, 23].map(
        (h) =>
          sessionBudget({
            now: ist(h, 0),
            exchange: 'MCX',
            dailyAtr: ATR,
            todayHigh: 24_650,
            todayLow: 24_520,
          }).points as number,
      );

      for (let i = 1; i < budgets.length; i += 1) {
        expect(budgets[i]).toBeLessThanOrEqual(budgets[i - 1]);
      }
    });
  });

  describe('reported shape', () => {
    it('always states one plain sentence carrying the numbers behind it', () => {
      const b = sessionBudget({
        now: ist(12, 44),
        exchange: 'NSE',
        dailyAtr: ATR,
        todayHigh: 24_700,
        todayLow: 24_520,
      });

      expect(b.reason).toMatch(/^[A-Z].*\.$/);
      expect(b.reason).toContain('44%');
      expect(b.reason).toContain('0.90x');
    });

    it('keeps sessionFractionLeft inside 0..1 at every hour of the day', () => {
      for (let h = 0; h < 24; h += 1) {
        for (const exchange of ['NSE', 'MCX']) {
          const f = sessionBudget({
            now: ist(h, 0),
            exchange,
            dailyAtr: ATR,
            todayHigh: 24_650,
            todayLow: 24_520,
          }).sessionFractionLeft;
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
        }
      }
    });

    it('never throws on a fully absent input object', () => {
      expect(() => sessionBudget({} as never)).not.toThrow();
      const b = sessionBudget({} as never);
      expect(b.points).toBeNull();
    });
  });
});
