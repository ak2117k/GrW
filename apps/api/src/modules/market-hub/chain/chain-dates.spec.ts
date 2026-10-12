import { expiryCloseAt, localMidnight, nextYmd, ymdLocal } from './chain-dates';

describe('chain dates (host-local, as master-contract.ts stores expiries)', () => {
  it('round-trips YYYY-MM-DD through host-local midnight on any host timezone', () => {
    expect(ymdLocal(localMidnight('2026-10-13'))).toBe('2026-10-13');
    expect(localMidnight('2026-10-13').getHours()).toBe(0);
  });

  it('nextYmd crosses month and year ends', () => {
    expect(nextYmd('2026-10-31')).toBe('2026-11-01');
    expect(nextYmd('2026-12-31')).toBe('2027-01-01');
  });

  it('expiry close is 15:30 IST, or 23:30 IST for MCX', () => {
    expect(expiryCloseAt('2026-10-13', 'NFO').toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(expiryCloseAt('2026-10-16', 'MCX').toISOString()).toBe('2026-10-16T18:00:00.000Z');
  });
});
