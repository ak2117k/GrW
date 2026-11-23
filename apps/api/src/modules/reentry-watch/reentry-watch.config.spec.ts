import { parseReentryWatchConfig } from './reentry-watch.config';

describe('parseReentryWatchConfig', () => {
  it('unset / paper → paper, no problems (today\'s behaviour)', () => {
    expect(parseReentryWatchConfig({})).toMatchObject({ mode: 'paper', problems: [] });
    expect(parseReentryWatchConfig({ REENTRY_WATCH: ' Paper ' })).toMatchObject({ mode: 'paper', problems: [] });
  });

  it('off → off', () => {
    expect(parseReentryWatchConfig({ REENTRY_WATCH: 'off' })).toMatchObject({ mode: 'off', problems: [] });
  });

  it('live → live', () => {
    expect(parseReentryWatchConfig({ REENTRY_WATCH: 'LIVE' })).toMatchObject({ mode: 'live', problems: [] });
  });

  it('unknown → paper with a problem (the safe value)', () => {
    const c = parseReentryWatchConfig({ REENTRY_WATCH: 'yes' });
    expect(c.mode).toBe('paper');
    expect(c.problems).toHaveLength(1);
    expect(c.problems[0]).toContain('REENTRY_WATCH=yes');
  });

  it('carries the live limits: defaults, and bad values reported as problems', () => {
    expect(parseReentryWatchConfig({}).live).toEqual({
      riskRupees: 2000, maxPerTrade: 4, maxPerDay: 6, maxLosses: 3, fromIst: '09:45', nseUntilIst: '15:00', mcxUntilIst: '23:00', noEntryLastMin: 30,
    });
    const c = parseReentryWatchConfig({ REENTRY_WATCH: 'live', REENTRY_LIVE_MAX_PER_DAY: 'lots', REENTRY_LIVE_MAX_PER_TRADE: '3' });
    expect(c.mode).toBe('live');
    expect(c.live).toMatchObject({ maxPerDay: 6, maxPerTrade: 3 });
    expect(c.problems).toEqual([expect.stringContaining('REENTRY_LIVE_MAX_PER_DAY=lots')]);
  });
});
