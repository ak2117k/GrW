import { computeExitOutcome, isWindowCovered, outcomeWindowEnd } from './outcome';
import type { MinuteBar } from './types';

const D = new Date('2026-10-14T11:01:20Z'); // 16:31:20 IST
const M = Date.parse('2026-10-14T11:01:00Z');
const bar = (minAfter: number, low: number, high: number, close: number): MinuteBar => ({ ts: M + minAfter * 60_000, open: close, high, low, close });
const BARS = [
  bar(0, 520, 530, 527),       // the decision's own minute — ignored
  bar(1, 523, 529, 528), bar(10, 526, 533, 532), bar(14, 529, 535, 534),
  bar(29, 531, 538, 537), bar(45, 535, 542, 540), bar(59, 536, 541, 539),
];

describe('computeExitOutcome', () => {
  it('LONG: missed = best after − exit, saved = exit − worst after; closes at +15/+30/+60', () => {
    const r = computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(r).toMatchObject({ barsUsed: 6, maxAfter: 542, minAfter: 523, closeAt15: 534, closeAt30: 537, closeAt60: 539, closeAtEnd: 539 });
    expect(r.missedPnl).toBeCloseTo(1490, 6);
    expect(r.savedPnl).toBeCloseTo(410, 6);
    expect(r.netAtEnd).toBeCloseTo(1190, 6);
  });
  it('SHORT is mirrored', () => {
    const r = computeExitOutcome({ positionSide: 'SHORT', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(r.missedPnl).toBeCloseTo(410, 6);
    expect(r.savedPnl).toBeCloseTo(1490, 6);
    expect(r.netAtEnd).toBeCloseTo(-1190, 6);
  });
  it('window end at the exchange close cuts later bars', () => {
    const r = computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(M + 20 * 60_000), bars: BARS })!;
    expect(r).toMatchObject({ barsUsed: 3, maxAfter: 535, closeAt30: null, closeAt60: null, closeAtEnd: 534 });
  });
  it('no bar after the decision ⇒ null; never negative missed/saved', () => {
    expect(computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: [BARS[0]] })).toBeNull();
    const up = computeExitOutcome({ positionSide: 'LONG', qty: 1, decisionPrice: 500, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(up.savedPnl).toBe(0);
  });
  it('non-finite bars are ignored; a bad decision price ⇒ null', () => {
    const junk = [...BARS, { ts: M + 5 * 60_000, open: NaN, high: NaN, low: NaN, close: NaN }];
    expect(computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: junk })!.barsUsed).toBe(6);
    expect(computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: NaN, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })).toBeNull();
  });
});

describe('isWindowCovered / outcomeWindowEnd', () => {
  it('needs a bar near the end and >= 50 % of minutes', () => {
    const full = Array.from({ length: 60 }, (_, i) => bar(i + 1, 1, 2, 1.5));
    expect(isWindowCovered(full, D, new Date(M + 61 * 60_000))).toBe(true);
    expect(isWindowCovered(full.slice(0, 40), D, new Date(M + 61 * 60_000))).toBe(false);
    expect(isWindowCovered(full.filter((_, i) => i % 3 === 0 || i > 55), D, new Date(M + 61 * 60_000))).toBe(false);
  });
  it('window end = min(decision + window, close)', () => {
    expect(outcomeWindowEnd(D, 60, null)).toEqual(new Date(D.getTime() + 3_600_000));
    expect(outcomeWindowEnd(D, 60, new Date(D.getTime() + 600_000))).toEqual(new Date(D.getTime() + 600_000));
  });
});
