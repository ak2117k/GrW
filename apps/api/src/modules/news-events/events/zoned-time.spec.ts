import { addDaysYmd, istLabel, isValidTimeZone, weekdayOfYmd, ymdInTz, zonedToUtc } from './zoned-time';

describe('zonedToUtc — Intl only, no hand-coded offsets', () => {
  it.each([
    ['2026-03-04', '10:30', 'America/New_York', '2026-03-04T15:30:00.000Z'], // EST, before the Mar 8 switch
    ['2026-03-11', '10:30', 'America/New_York', '2026-03-11T14:30:00.000Z'], // EDT
    ['2026-10-28', '10:30', 'America/New_York', '2026-10-28T14:30:00.000Z'], // EDT, before the Nov 1 switch
    ['2026-11-04', '10:30', 'America/New_York', '2026-11-04T15:30:00.000Z'], // EST
    ['2026-12-09', '14:00', 'America/New_York', '2026-12-09T19:00:00.000Z'], // FOMC: 00:30 IST the next day
    ['2026-12-04', '10:00', 'Asia/Kolkata', '2026-12-04T04:30:00.000Z'],
  ])('%s %s %s → %s', (ymd, hhmm, tz, iso) => {
    expect(zonedToUtc(ymd, hhmm, tz).toISOString()).toBe(iso);
  });

  it('labels in IST and crosses IST midnight correctly', () => {
    expect(istLabel(zonedToUtc('2026-12-09', '14:00', 'America/New_York'))).toBe('2026-12-10 00:30 IST');
    expect(ymdInTz(Date.parse('2026-12-09T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-12-10');
  });

  it('date helpers', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOfYmd('2026-10-14')).toBe(3);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
