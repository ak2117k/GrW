import { isHullScanner } from './ungated-scanner-filter';

describe('isHullScanner', () => {
  it('matches the canonical Hull scanner name', () => {
    expect(isHullScanner('Anand 100Hull >200 hull')).toBe(true);
  });

  it('matches case-insensitively (all upper)', () => {
    expect(isHullScanner('ANAND 100HULL >200 HULL')).toBe(true);
  });

  it('matches a future Hull variant (substring, not exact)', () => {
    expect(isHullScanner('Anand 100Hull >200 hull v2')).toBe(true);
  });

  it('rejects a non-Hull scanner', () => {
    expect(isHullScanner('ANAND HIGH GAINER BULLISH MAY26')).toBe(false);
  });

  it('rejects null (fail-closed: no scanner name)', () => {
    expect(isHullScanner(null)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isHullScanner('')).toBe(false);
  });
});
