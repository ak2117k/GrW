import { evaluateTradePolicy, isStrictWindow } from './trade-policy';

// A Date whose IST time-of-day is hh:mm. IST = UTC+5:30.
function istAt(hh: number, mm: number): Date {
  const utcMinutes = hh * 60 + mm - (5 * 60 + 30);
  const d = new Date('2026-05-19T00:00:00Z');
  d.setUTCMinutes(d.getUTCMinutes() + utcMinutes);
  return d;
}

describe('isStrictWindow — 11:45-14:00 IST, half-open', () => {
  it('is false at 11:44, true at 11:45, true at 13:59, false at 14:00', () => {
    expect(isStrictWindow(istAt(11, 44))).toBe(false);
    expect(isStrictWindow(istAt(11, 45))).toBe(true);
    expect(isStrictWindow(istAt(13, 59))).toBe(true);
    expect(isStrictWindow(istAt(14, 0))).toBe(false);
  });
});

describe('evaluateTradePolicy — admission (R3)', () => {
  it('outside the window admits score >= 47', () => {
    expect(evaluateTradePolicy({ score: 47, at: istAt(10, 0) }).admitted).toBe(true);
    expect(evaluateTradePolicy({ score: 46, at: istAt(10, 0) }).admitted).toBe(false);
  });

  it('inside the window admits only score >= 75', () => {
    expect(evaluateTradePolicy({ score: 74, at: istAt(12, 0) }).admitted).toBe(false);
    expect(evaluateTradePolicy({ score: 75, at: istAt(12, 0) }).admitted).toBe(true);
    expect(evaluateTradePolicy({ score: 74, at: istAt(12, 0) }).reason)
      .toContain('11:45-14:00');
  });
});

describe('evaluateTradePolicy — capital (R4)', () => {
  it('outside the window: tiered by score, half-open boundaries', () => {
    // Tier-1 (₹1L) covers [47, 65).
    expect(evaluateTradePolicy({ score: 47, at: istAt(10, 0) }).capital).toBe(100_000);
    expect(evaluateTradePolicy({ score: 60, at: istAt(10, 0) }).capital).toBe(100_000);
    expect(evaluateTradePolicy({ score: 64, at: istAt(10, 0) }).capital).toBe(100_000);
    expect(evaluateTradePolicy({ score: 65, at: istAt(10, 0) }).capital).toBe(150_000);
    expect(evaluateTradePolicy({ score: 74, at: istAt(10, 0) }).capital).toBe(150_000);
    expect(evaluateTradePolicy({ score: 75, at: istAt(10, 0) }).capital).toBe(200_000);
    expect(evaluateTradePolicy({ score: 90, at: istAt(10, 0) }).capital).toBe(200_000);
  });

  it('inside the window: flat 1,00,000 regardless of score', () => {
    expect(evaluateTradePolicy({ score: 90, at: istAt(12, 30) }).capital).toBe(100_000);
  });

  it('returns a valid capital even when not admitted (caller uses it unconditionally)', () => {
    const r = evaluateTradePolicy({ score: 30, at: istAt(10, 0) });
    expect(r.admitted).toBe(false);
    expect(r.capital).toBe(100_000);
  });
});
