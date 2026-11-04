import { chargesForLeg } from '../../trade-sentinel/charges';
import { gradeCarry, gradeExit, gradeGated, gradeSkip, gradeTake, isWrong, priceAt, takeOutcome, WRONG_RUPEES } from './grade';
import type { Bar } from './types';

const MIN = 60_000;
/** Bars starting the minute after `t0`, one per minute, closes from `closes` (high/low = close unless given). */
function barsAfter(t0: number, closes: number[], wicks: Record<number, { high?: number; low?: number }> = {}): Bar[] {
  const start = Math.floor(t0 / MIN) * MIN + MIN;
  return closes.map((c, k) => ({ ts: start + k * MIN, close: c, high: wicks[k]?.high ?? c, low: wicks[k]?.low ?? c }));
}
const linear = (from: number, to: number, n: number) => Array.from({ length: n }, (_, k) => Math.round((from + ((to - from) * (k + 1)) / n) * 100) / 100);

describe('isWrong', () => {
  it('delta 499 ⇒ RIGHT, 500 ⇒ WRONG', () => {
    expect(isWrong(499, null)).toBe(false);
    expect(isWrong(WRONG_RUPEES, null)).toBe(true);
  });
  it('one noise unit is enough, a null delta never is', () => {
    expect(isWrong(300, 250)).toBe(true);
    expect(isWrong(200, 250)).toBe(false);
    expect(isWrong(null, 1)).toBe(false);
  });
});

describe('gradeExit', () => {
  it('missing bars ⇒ UNSCORABLE, not RIGHT', () => {
    const base = { side: 'LONG' as const, exitPrice: 100, decidedAt: Date.parse('2026-11-04T05:00:00Z'), lotQty: 75, valueFactor: 1, segment: 'OPT' as const };
    for (const g of gradeExit({ ...base, path: null })) {
      expect(g.verdict).toBe('UNSCORABLE');
      expect(g.deltaRupees).toBeNull();
      expect(g.reason).toMatch(/missing bars/);
    }
    // A path with a 20-minute hole is not a path.
    const holed = barsAfter(base.decidedAt, [100, 101, 102]).concat(barsAfter(base.decidedAt + 25 * MIN, linear(102, 140, 40)));
    const g30 = gradeExit({ ...base, path: holed, horizons: ['30m'] })[0];
    expect(g30.verdict).toBe('UNSCORABLE');
    expect(g30.reason).toMatch(/missing bars/);
  });

  it('GOLD delta uses contract value (×100): exit 566.5, 865 at +60m, lot 1 ⇒ ₹29,850 minus charges, WRONG', () => {
    const t0 = Date.parse('2026-11-04T05:31:00Z'); // 11:01 IST
    const path = barsAfter(t0, linear(566.5, 865, 59));
    const [g15, g30, g60] = gradeExit({ side: 'LONG', exitPrice: 566.5, decidedAt: t0, lotQty: 1, valueFactor: 100, segment: 'OPT', path });
    const legs = chargesForLeg({ segment: 'OPT', leg: 'SELL', price: 865, qty: 1, valueFactor: 100 }).total - chargesForLeg({ segment: 'OPT', leg: 'SELL', price: 566.5, qty: 1, valueFactor: 100 }).total;
    expect(g60.horizon).toBe('60m');
    expect(g60.deltaRupees).toBeCloseTo(29850 - legs, 1);
    expect(g60.deltaRupees as number).toBeLessThan(29850);
    expect(g60.deltaRupees as number).toBeGreaterThan(29000);
    expect(g60.verdict).toBe('WRONG');
    expect(g15.verdict).toBe('WRONG');
    expect(g30.verdict).toBe('WRONG');
  });

  it('NIFTY exit in noise then +40 pts within 30m ⇒ WRONG', () => {
    const t0 = Date.parse('2026-11-04T04:30:00Z');
    const noise = [120.5, 119.5, 120.2, 119.8, 120.4, 119.9, 120.1, 120, 119.7, 120.3];
    const path = barsAfter(t0, [...noise, ...linear(120, 160, 19), 159, 158]);
    const g30 = gradeExit({ side: 'LONG', exitPrice: 120, decidedAt: t0, lotQty: 75, valueFactor: 1, segment: 'OPT', path, horizons: ['30m'] })[0];
    expect(g30.verdict).toBe('WRONG');
    expect(g30.deltaRupees as number).toBeGreaterThan(2900);
  });

  it('LAURUSLABS 2520CE exit 20.15, path min 16.25 within 60m ⇒ RIGHT', () => {
    const t0 = Date.parse('2026-11-02T04:01:00Z'); // 09:31 IST
    const closes = [20.3, 20.6, 20.9, 21.2, 20.5, 20.1, 19.8, 19.5, 19.2, 19.0, 18.8, 18.9, 19.1, 19.0, 19.0, ...linear(18.9, 16.6, 15), ...linear(16.8, 18.2, 29)];
    const path = barsAfter(t0, closes, { 3: { high: 22.9 }, 29: { low: 16.25 } });
    expect(Math.max(...path.map((b) => b.high))).toBe(22.9);
    expect(Math.min(...path.map((b) => b.low))).toBe(16.25);
    const grades = gradeExit({ side: 'LONG', exitPrice: 20.15, decidedAt: t0, lotQty: 425, valueFactor: 1, segment: 'OPT', path });
    expect(grades.map((g) => g.verdict)).toEqual(['RIGHT', 'RIGHT', 'RIGHT']);
    expect(grades[2].deltaRupees as number).toBeLessThan(0);
  });

  it('a HOLD is graded the other way round, and precomputed closes win over the path', () => {
    const t0 = Date.parse('2026-11-04T05:00:00Z');
    const [g] = gradeExit({ side: 'LONG', exitPrice: 100, decidedAt: t0, lotQty: 50, valueFactor: 1, segment: 'OPT', path: null, closes: { '30m': 80 }, chosen: 'hold', horizons: ['30m'] });
    expect(g.verdict).toBe('WRONG'); // holding lost ₹1,000 per lot vs exiting
    expect(g.deltaRupees as number).toBeGreaterThan(990);
  });

  it('priceAt needs the horizon covered', () => {
    const t0 = Date.parse('2026-11-04T05:00:00Z');
    expect(priceAt(barsAfter(t0, linear(1, 2, 5)), t0, 30 * MIN).price).toBeNull();
    expect(priceAt(barsAfter(t0, linear(1, 2, 29)), t0, 30 * MIN).price).toBe(2);
  });
});

describe('gradeSkip / gradeTake', () => {
  const t0 = Date.parse('2026-11-04T05:31:00Z');
  const base = { side: 'BUY' as const, entry: 566.5, entryTs: t0, sl: 424.5, targets: [600, 700, 1000], lotQty: 1, valueFactor: 100, segment: 'OPT' as const, cap: 2000, endTs: Date.parse('2026-11-04T18:00:00Z') };

  it('a GOLD skip that ran to its first target is WRONG, sized in real ₹', () => {
    const g = gradeSkip({ ...base, path: barsAfter(t0, linear(567, 640, 30)) });
    expect(g.verdict).toBe('WRONG');
    expect(g.pnlChosen).toBe(0);
    expect(g.pnlAlternative as number).toBeGreaterThan(3100); // 33.5 pts × ₹100 − ~₹157 round-trip charges
    expect(g.pnlAlternative as number).toBeLessThan(3350);
  });

  it('the cap-sized stop is real ₹: a 25-pt GOLD dip stops the ₹2,000 trade before the target', () => {
    const path = barsAfter(t0, [...linear(566, 540, 10), ...linear(545, 700, 20)]);
    const t = takeOutcome({ ...base, path });
    expect(t.outcome?.result).toBe('STOPPED');
    expect(t.outcome?.stop).toBe(546.5);
    expect(gradeSkip({ outcome: t }).verdict).toBe('RIGHT');
    expect(gradeTake({ outcome: t }).verdict).toBe('WRONG');
  });

  it('missing bars ⇒ UNSCORABLE, not RIGHT', () => {
    expect(gradeSkip({ ...base, path: [] }).verdict).toBe('UNSCORABLE');
    expect(gradeTake({ ...base, path: null }).verdict).toBe('UNSCORABLE');
  });
});

describe('gradeCarry / gradeGated', () => {
  it('a CARRY that gapped against the position is WRONG; no next-session price is UNSCORABLE', () => {
    const g = gradeCarry({ decision: 'CARRY', side: 'LONG', decisionPrice: 100, priceAt1015: 80, lotQty: 75, valueFactor: 1, segment: 'OPT' });
    expect(g.horizon).toBe('next1h');
    expect(g.verdict).toBe('WRONG');
    expect(gradeCarry({ decision: 'EXIT', side: 'LONG', decisionPrice: 100, priceAt1015: null, lotQty: 75, valueFactor: 1, segment: 'OPT' }).verdict).toBe('UNSCORABLE');
  });

  it('a gated exit that later exited much lower is WRONG', () => {
    const g = gradeGated({ side: 'LONG', gatedPrice: 31.7, eventualExit: 20.15, lotQty: 425, valueFactor: 1, segment: 'OPT' });
    expect(g.verdict).toBe('WRONG');
    expect(g.deltaRupees as number).toBeGreaterThan(4800);
    expect(gradeGated({ side: 'LONG', gatedPrice: 31.7, eventualExit: null, lotQty: 425, valueFactor: 1, segment: 'OPT' }).verdict).toBe('UNSCORABLE');
  });
});
