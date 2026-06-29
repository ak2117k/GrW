import { computeExpiry, MIN_SIGNAL_TTL_MINUTES, MAX_SIGNAL_TTL_HOURS } from './compute-expiry';

describe('computeExpiry', () => {
  it('returns a non-null Date for NSE', () => {
    const result = computeExpiry('NSE');
    expect(result).toBeInstanceOf(Date);
    expect(Number.isFinite(result.getTime())).toBe(true);
  });

  it('returns a non-null Date for MCX', () => {
    const result = computeExpiry('MCX');
    expect(result).toBeInstanceOf(Date);
    expect(Number.isFinite(result.getTime())).toBe(true);
  });

  it('never returns an expiry in the past', () => {
    const now = new Date();
    const result = computeExpiry('NSE', now);
    expect(result.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('honours the MIN_SIGNAL_TTL_MINUTES floor for late-session generation', () => {
    // 15:25 IST on a weekday = 09:55 UTC. NSE closes at 15:30 IST, so the
    // session-close calc is only 5 min away — the floor should kick in.
    const now = new Date(Date.UTC(2026, 4, 11, 9, 55, 0));
    const result = computeExpiry('NSE', now);
    const expectedFloor = now.getTime() + MIN_SIGNAL_TTL_MINUTES * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expectedFloor);
  });

  it('clamps to MAX_SIGNAL_TTL_HOURS for after-hours generation', () => {
    // 23:00 UTC = 04:30 IST next day — well past MCX close. The candidate
    // would land at the next day's 15:30 IST (~16.5h away on NSE), which
    // exceeds the 14h cap.
    const now = new Date(Date.UTC(2026, 4, 11, 23, 0, 0));
    const result = computeExpiry('NSE', now);
    const expectedCap = now.getTime() + MAX_SIGNAL_TTL_HOURS * 60 * 60 * 1000;
    expect(result.getTime()).toBeLessThanOrEqual(expectedCap);
  });

  it('MCX expiry is later in the day than NSE expiry (same `now`)', () => {
    // Mid-morning IST: 10:00 IST = 04:30 UTC.
    const now = new Date(Date.UTC(2026, 4, 11, 4, 30, 0));
    const nse = computeExpiry('NSE', now);
    const mcx = computeExpiry('MCX', now);
    // NSE closes at 15:30 IST, MCX at 23:30 IST — MCX should expire ~8h later.
    expect(mcx.getTime()).toBeGreaterThan(nse.getTime());
  });
});
