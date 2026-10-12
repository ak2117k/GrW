import { describe, expect, it } from 'vitest';
import { chainBadge, chainPollMs, formatAge } from './chainAge';

const NOW = Date.parse('2026-10-12T05:00:00Z'); // 10:30 IST

describe('chainAge', () => {
  it('formats ages in s, min and h', () => {
    expect(formatAge(4_200)).toBe('4 s');
    expect(formatAge(185_000)).toBe('3 min');
    expect(formatAge(2 * 3600_000 + 5)).toBe('2 h');
  });

  it('labels hub chains Live / Stale and a closed market by its IST snapshot time', () => {
    expect(chainBadge({ at: new Date(NOW - 4_000).toISOString(), source: 'hub', status: 'fresh' }, NOW)).toEqual({ label: 'Live · 4 s', tone: 'live' });
    expect(chainBadge({ at: new Date(NOW - 40_000).toISOString(), source: 'hub', status: 'stale' }, NOW)).toEqual({ label: 'Stale · 40 s', tone: 'stale' });
    expect(chainBadge({ at: '2026-10-12T09:59:00.000Z', source: 'hub', status: 'market-closed' }, NOW)).toEqual({ label: 'Closed · 15:29 snapshot', tone: 'closed' });
  });

  it('labels the NSE fallback as such, and shows nothing without a time', () => {
    expect(chainBadge({ at: new Date(NOW - 9_000).toISOString(), source: 'nse', status: 'fresh' }, NOW)).toEqual({ label: 'NSE · 9 s', tone: 'legacy' });
    expect(chainBadge({ source: 'hub', status: 'fresh' }, NOW)).toBeNull();
    expect(chainBadge(null, NOW)).toBeNull();
  });

  it('polls every 10 s while live or stale and every 60 s on a closed market', () => {
    expect(chainPollMs('fresh')).toBe(10_000);
    expect(chainPollMs('stale')).toBe(10_000);
    expect(chainPollMs(undefined)).toBe(10_000);
    expect(chainPollMs('market-closed')).toBe(60_000);
  });
});
