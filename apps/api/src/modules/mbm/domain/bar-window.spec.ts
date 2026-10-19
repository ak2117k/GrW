import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { catchUpFloor, completedBars, fetchFrom, isRefreshTick, recentSessionOpens, tickFloor } from './bar-window';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const at = (iso: string) => new Date(iso);
const bar = (iso: string, close = 100) => ({ timestamp: at(iso), open: close, high: close, low: close, close, volume: 1 });

// 2026-10-20 (Tue) is Dussehra, an NSE holiday. NSE opens 09:15 IST = 03:45Z.
describe('bar-window', () => {
  it('ticks only on trading days between 09:15 and 15:35 IST', () => {
    expect(isRefreshTick(cal, at('2026-10-19T03:45:20Z'))).toBe(true); // 09:15:20
    expect(isRefreshTick(cal, at('2026-10-19T10:05:20Z'))).toBe(true); // 15:35:20
    expect(isRefreshTick(cal, at('2026-10-19T03:40:20Z'))).toBe(false); // 09:10
    expect(isRefreshTick(cal, at('2026-10-19T10:10:20Z'))).toBe(false); // 15:40
    expect(isRefreshTick(cal, at('2026-10-20T05:00:20Z'))).toBe(false); // holiday
    expect(isRefreshTick(cal, at('2026-10-18T05:00:20Z'))).toBe(false); // Sunday
  });

  it('boot catch-up floor skips weekends and holidays (3 sessions back)', () => {
    // Wed 10:00 IST → sessions Wed 21, Mon 19, Fri 16.
    expect(recentSessionOpens(cal, at('2026-10-21T04:30:00Z'), 3).map((d) => d.toISOString())).toEqual([
      '2026-10-21T03:45:00.000Z',
      '2026-10-19T03:45:00.000Z',
      '2026-10-16T03:45:00.000Z',
    ]);
    expect(catchUpFloor(cal, at('2026-10-21T04:30:00Z'))?.toISOString()).toBe('2026-10-16T03:45:00.000Z');
    // Before today's open, today does not count: Wed 08:00 IST → Mon 19, Fri 16, Thu 15.
    expect(catchUpFloor(cal, at('2026-10-21T02:30:00Z'))?.toISOString()).toBe('2026-10-15T03:45:00.000Z');
  });

  it('tick floor is today’s open, or null on a holiday', () => {
    expect(tickFloor(cal, at('2026-10-19T06:00:20Z'))?.toISOString()).toBe('2026-10-19T03:45:00.000Z');
    expect(tickFloor(cal, at('2026-10-20T06:00:20Z'))).toBeNull();
  });

  it('fetchFrom resumes at the last bar but never before the floor', () => {
    const floor = at('2026-10-19T03:45:00Z');
    expect(fetchFrom(null, floor)).toBe(floor);
    expect(fetchFrom(at('2026-10-16T09:59:00Z'), floor)).toBe(floor);
    const last = at('2026-10-19T05:10:00Z');
    expect(fetchFrom(last, floor)).toBe(last);
  });

  it('keeps only complete, finite bars at/after from', () => {
    const now = at('2026-10-19T05:10:30Z');
    const from = at('2026-10-19T05:07:00Z');
    const kept = completedBars(
      [
        bar('2026-10-19T05:06:00Z'), // before from
        bar('2026-10-19T05:08:00Z'),
        bar('2026-10-19T05:09:00Z'), // ends 05:10:00 ≤ now
        bar('2026-10-19T05:10:00Z'), // still forming
        { ...bar('2026-10-19T05:07:00Z'), close: NaN },
      ],
      from,
      now,
    );
    expect(kept.map((b) => b.timestamp.toISOString())).toEqual(['2026-10-19T05:08:00.000Z', '2026-10-19T05:09:00.000Z']);
  });
});
