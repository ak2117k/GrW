import { PRIORITY_RESERVE_CALLS, priorityRunDue, touchesPreOpenUniverse } from './impact';

describe('pre-open priority cadence (off-session 30 min)', () => {
  const NOW = new Date('2026-11-01T09:00:00Z');
  it('due 30 min after the last run, only while the session reserve is left', () => {
    expect(priorityRunDue(NOW, new Date(NOW.getTime() - 30 * 60_000), 5, 60)).toBe(true);
    expect(priorityRunDue(NOW, new Date(NOW.getTime() - 20 * 60_000), 5, 60)).toBe(false);
    expect(priorityRunDue(NOW, null, 60 - PRIORITY_RESERVE_CALLS, 60)).toBe(false);
    expect(priorityRunDue(NOW, null, 0, 60)).toBe(true);
  });
  it('a cluster touches the universe by instrument, index or headline', () => {
    expect(touchesPreOpenUniverse({ instruments: ['CRUDEOIL'], indices: [], headline: 'x' })).toBe(true);
    expect(touchesPreOpenUniverse({ instruments: [], indices: ['NIFTY'], headline: 'x' })).toBe(true);
    expect(touchesPreOpenUniverse({ instruments: [], indices: [], headline: 'Iran, Qatari mediators hold talks; Brent slips' })).toBe(true);
    expect(touchesPreOpenUniverse({ instruments: ['TCS'], indices: [], headline: 'TCS wins order' })).toBe(false);
  });
});
