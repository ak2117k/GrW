import { describe, it, expect } from 'vitest';
import { presetRange, todayIso, toIsoDate, DATE_PRESETS } from './backtestDateRange';

describe('backtestDateRange', () => {
  it('todayIso returns a YYYY-MM-DD string', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('toIsoDate formats a Date as its IST calendar date', () => {
    // 2026-05-15 20:00 UTC = 2026-05-16 01:30 IST → the IST calendar day.
    expect(toIsoDate(new Date('2026-05-15T20:00:00Z'))).toBe('2026-05-16');
  });

  it('every preset ends today and starts strictly before it', () => {
    const today = todayIso();
    for (const p of DATE_PRESETS) {
      const r = presetRange(p);
      expect(r.endDate).toBe(today);
      expect(r.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.startDate < r.endDate).toBe(true);
    }
  });

  it('longer presets reach further back', () => {
    expect(presetRange('1Y').startDate < presetRange('6M').startDate).toBe(true);
    expect(presetRange('6M').startDate < presetRange('3M').startDate).toBe(true);
    expect(presetRange('3M').startDate < presetRange('1M').startDate).toBe(true);
  });
});
