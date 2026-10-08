import { SessionClock } from './session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';

// IST = UTC+5:30. Helper: build a UTC Date from an IST wall-clock time.
const ist = (isoLocal: string) => new Date(new Date(`${isoLocal}Z`).getTime() - 5.5 * 3600_000);

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

describe('SessionClock', () => {
  it('opens NSE at 09:15 and closes it at 15:30 IST on a weekday', () => {
    expect(clock.phase('NSE', ist('2026-10-07T09:14:59'))).toBe('closed');
    expect(clock.phase('NSE', ist('2026-10-07T09:15:00'))).toBe('open');
    expect(clock.phase('NSE', ist('2026-10-07T15:29:59'))).toBe('open');
    expect(clock.phase('NSE', ist('2026-10-07T15:30:00'))).toBe('closed');
  });

  it('reports pre-open 09:00–09:08 for cash NSE/BSE only', () => {
    const t = ist('2026-10-07T09:05:00');
    expect(clock.phase('NSE', t)).toBe('pre-open');
    expect(clock.phase('BSE', t)).toBe('pre-open');
    expect(clock.phase('NFO', t)).toBe('closed');
    expect(clock.phase('MCX', t)).toBe('open'); // MCX opens 09:00
  });

  it('is closed on weekends and on listed holidays', () => {
    expect(clock.isOpen('NSE', ist('2026-10-10T10:00:00'))).toBe(false); // Saturday
    expect(clock.isTradingDay('NSE', ist('2026-10-20T10:00:00'))).toBe(false); // Dussehra
    expect(clock.isOpen('MCX', ist('2026-10-20T19:00:00'))).toBe(false);
  });

  it('treats BFO holidays as BSE holidays', () => {
    expect(clock.isTradingDay('BFO', ist('2026-10-20T10:00:00'))).toBe(false);
  });

  it('closes MCX at 23:30 unless the date is in a configured late-close range', () => {
    const t = ist('2026-11-12T23:40:00'); // Thursday
    expect(clock.isOpen('MCX', t)).toBe(false);
    const late = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
    });
    expect(late.isOpen('MCX', t)).toBe(true);
    expect(late.minutesToClose('MCX', t)).toBe(15);
  });

  it('gives minutes to close only while open', () => {
    expect(clock.minutesToClose('NSE', ist('2026-10-07T15:00:00'))).toBe(30);
    expect(clock.minutesToClose('NSE', ist('2026-10-07T16:00:00'))).toBeNull();
  });

  it('finds the next open across a weekend and a holiday', () => {
    expect(clock.nextOpen('NSE', ist('2026-10-16T16:00:00'))?.toISOString()).toBe(
      ist('2026-10-19T09:15:00').toISOString(),
    );
    expect(clock.nextOpen('NSE', ist('2026-10-19T16:00:00'))?.toISOString()).toBe(
      ist('2026-10-21T09:15:00').toISOString(), // 20th is Dussehra
    );
  });

  it('reports a missing holiday calendar: this year always, next year from December', () => {
    expect(clock.calendarGap(ist('2026-10-07T10:00:00'))).toBeNull();
    expect(clock.calendarGap(ist('2026-12-02T10:00:00'))).toBe(2027);
    expect(clock.calendarGap(ist('2027-01-05T10:00:00'))).toBe(2027);
  });

  it('exposes the trading window for a trading day and null otherwise', () => {
    const at = (s: string) => new Date(Date.parse(`${s}+05:30`));
    expect(clock.tradingWindow('NSE', at('2026-10-07T12:00:00'))).toEqual({ openMin: 555, closeMin: 930 });
    expect(clock.tradingWindow('NSE', at('2026-10-10T12:00:00'))).toBeNull(); // Saturday
    const late = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
    });
    expect(late.tradingWindow('MCX', at('2026-11-04T12:00:00'))).toEqual({ openMin: 540, closeMin: 1435 });
  });
});
