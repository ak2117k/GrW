import { SessionClock } from '../session-clock';
import { addDays, barEnd, expectedPerDay, istDay, istMidnight } from './trading-calendar';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const clock = new SessionClock({
  holidays: { 2026: [{ date: '2026-10-02', name: 'Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'NFO', 'MCX'] }] },
  mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
});
const day = (ymd: string) => ({ from: istMidnight(ymd), to: istMidnight(addDays(ymd, 1)) });

describe('trading calendar', () => {
  it('converts between instants and IST dates at the IST midnight boundary', () => {
    expect(istDay(Date.parse('2026-10-07T18:29:59Z'))).toBe('2026-10-07');
    expect(istDay(Date.parse('2026-10-07T18:30:00Z'))).toBe('2026-10-08');
    expect(istMidnight('2026-10-08')).toBe(Date.parse('2026-10-07T18:30:00Z'));
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('expects 375 one-minute, 7 hourly and 1 daily NSE bars on a full weekday', () => {
    const { from, to } = day('2026-10-07');
    const asOf = ist('2026-10-07T16:00:00');
    expect(expectedPerDay(clock, 'NSE', '1m', from, to, asOf)).toEqual(new Map([['2026-10-07', 375]]));
    expect(expectedPerDay(clock, 'NSE', '1h', from, to, asOf)).toEqual(new Map([['2026-10-07', 7]]));
    expect(expectedPerDay(clock, 'NSE', '1d', from, to, asOf)).toEqual(new Map([['2026-10-07', 1]]));
  });

  it('counts only completed bars', () => {
    const { from, to } = day('2026-10-07');
    // 10:00:30 → 09:15..09:59 are complete; the 10:00 bar ends at 10:01.
    expect(expectedPerDay(clock, 'NSE', '1m', from, to, ist('2026-10-07T10:00:30')).get('2026-10-07')).toBe(45);
    // The daily bar is complete only after the close.
    expect(expectedPerDay(clock, 'NSE', '1d', from, to, ist('2026-10-07T15:00:00')).size).toBe(0);
    // The last hourly bar (15:15) ends at the 15:30 close, not 16:15.
    expect(expectedPerDay(clock, 'NSE', '1h', from, to, ist('2026-10-07T15:30:00')).get('2026-10-07')).toBe(7);
  });

  it('omits weekends and holidays', () => {
    const from = istMidnight('2026-10-01'); // Thu
    const to = istMidnight('2026-10-06'); // Tue (exclusive)
    const asOf = ist('2026-10-07T00:00:00');
    // Thu 1, Fri 2 holiday, Sat 3, Sun 4, Mon 5
    expect([...expectedPerDay(clock, 'NSE', '1d', from, to, asOf).keys()]).toEqual(['2026-10-01', '2026-10-05']);
  });

  it('follows MCX hours, including the late-close window', () => {
    const asOf = ist('2026-11-06T00:00:00');
    expect(expectedPerDay(clock, 'MCX', '1m', day('2026-10-07').from, day('2026-10-07').to, asOf).get('2026-10-07')).toBe(870);
    expect(expectedPerDay(clock, 'MCX', '1m', day('2026-11-04').from, day('2026-11-04').to, asOf).get('2026-11-04')).toBe(895);
  });

  it('clips to the half-open range [from, to)', () => {
    const n = expectedPerDay(clock, 'NSE', '1m', ist('2026-10-07T10:00:00'), ist('2026-10-07T11:00:00'), ist('2026-10-08T00:00:00'));
    expect(n.get('2026-10-07')).toBe(60);
  });

  it('gives bar ends, clipped to the session close', () => {
    expect(barEnd(clock, 'NSE', '1m', ist('2026-10-07T10:00:00'))).toBe(ist('2026-10-07T10:01:00'));
    expect(barEnd(clock, 'NSE', '1h', ist('2026-10-07T15:15:00'))).toBe(ist('2026-10-07T15:30:00'));
    expect(barEnd(clock, 'NSE', '1d', istMidnight('2026-10-07'))).toBe(ist('2026-10-07T15:30:00'));
  });
});
