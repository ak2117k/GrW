import {
  isWithinEntryWindow,
  ENTRY_WINDOW_OPEN_MIN,
  ENTRY_WINDOW_CLOSE_MIN,
} from './market-hours';

/**
 * Build a UTC Date that represents a given IST wall-clock time on a given
 * weekday. IST = UTC + 5:30, so an IST time of HH:MM corresponds to a UTC
 * time of (HH:MM - 5:30). We pick a base date for each weekday so day-of-week
 * is controllable.
 *
 * Reference dates (all real calendar dates, UTC midnight):
 *   2026-05-18 = Monday    2026-05-22 = Friday
 *   2026-05-16 = Saturday  2026-05-17 = Sunday
 */
function istDate(dateYmd: string, istHour: number, istMin: number): Date {
  // IST minutes since UTC midnight of dateYmd, then subtract the 5:30 offset.
  const istTotalMin = istHour * 60 + istMin;
  const utcTotalMin = istTotalMin - (5 * 60 + 30);
  const base = new Date(`${dateYmd}T00:00:00.000Z`);
  return new Date(base.getTime() + utcTotalMin * 60_000);
}

describe('market-hours: isWithinEntryWindow', () => {
  it('exposes the entry-window cutoff constants (09:15 and 15:00 IST)', () => {
    expect(ENTRY_WINDOW_OPEN_MIN).toBe(9 * 60 + 15);
    expect(ENTRY_WINDOW_CLOSE_MIN).toBe(15 * 60);
  });

  describe('inside the window (weekday)', () => {
    it('returns true at exactly 09:15 IST on a Monday', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 9, 15))).toBe(true);
    });

    it('returns true at midday 12:00 IST on a Monday', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 12, 0))).toBe(true);
    });

    it('returns true at exactly 15:00 IST (cutoff is inclusive) on a Friday', () => {
      expect(isWithinEntryWindow(istDate('2026-05-22', 15, 0))).toBe(true);
    });
  });

  describe('after the 15:00 cutoff (weekday)', () => {
    it('returns false at 15:01 IST', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 15, 1))).toBe(false);
    });

    it('returns false at 15:30 IST (market close — still no new entries)', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 15, 30))).toBe(false);
    });

    it('returns false at 18:00 IST (evening)', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 18, 0))).toBe(false);
    });
  });

  describe('before 09:15 (weekday)', () => {
    it('returns false at 09:14 IST', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 9, 14))).toBe(false);
    });

    it('returns false at 06:00 IST (pre-market)', () => {
      expect(isWithinEntryWindow(istDate('2026-05-18', 6, 0))).toBe(false);
    });
  });

  describe('weekend', () => {
    it('returns false on a Saturday even at midday', () => {
      expect(isWithinEntryWindow(istDate('2026-05-16', 12, 0))).toBe(false);
    });

    it('returns false on a Sunday even at midday', () => {
      expect(isWithinEntryWindow(istDate('2026-05-17', 12, 0))).toBe(false);
    });
  });

  it('defaults to the current time when no argument is given', () => {
    // Just assert it returns a boolean — no time injection.
    expect(typeof isWithinEntryWindow()).toBe('boolean');
  });
});
