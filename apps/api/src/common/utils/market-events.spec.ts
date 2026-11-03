import { activeEvents, DEFAULT_MARKET_EVENT_DAYS, eventLabel, eventTags, marketEvents, withEventTags } from './market-events';

const ist = (s: string) => new Date(`${s}+05:30`);

describe('market event days', () => {
  it('default (env unset) is the US midterm results day', () => {
    expect(DEFAULT_MARKET_EVENT_DAYS).toBe('2026-11-04:US_MIDTERM_RESULTS');
    expect(marketEvents({})).toEqual([{ date: '2026-11-04', name: 'US_MIDTERM_RESULTS' }]);
  });

  it('MARKET_EVENT_DAYS replaces the default; off/none/empty → none; malformed entries ignored', () => {
    expect(marketEvents({ MARKET_EVENT_DAYS: '2026-12-10:fomc, junk, 2026-13-99:X ,2026-12-10:FOMC' })).toEqual([{ date: '2026-12-10', name: 'FOMC' }]);
    for (const v of ['off', 'NONE', '', ' ']) expect(marketEvents({ MARKET_EVENT_DAYS: v })).toEqual([]);
  });

  it('activeEvents matches the IST date of the instant', () => {
    expect(activeEvents(ist('2026-11-04T00:00:00'), {})).toHaveLength(1);
    expect(activeEvents(ist('2026-11-04T23:59:00'), {})).toHaveLength(1);
    expect(activeEvents(ist('2026-11-03T23:59:00'), {})).toEqual([]); // 18:29 UTC on the 3rd
    expect(activeEvents(new Date('2026-11-03T18:30:00Z'), {})).toHaveLength(1); // 00:00 IST on the 4th
    expect(activeEvents(ist('2026-11-05T09:15:00'), {})).toEqual([]);
  });

  it('tags: EVENT:<NAME>, appended once, existing tags (decision / learn) kept in order', () => {
    const at = ist('2026-11-04T09:20:00');
    expect(eventTags(at, {})).toEqual(['EVENT:US_MIDTERM_RESULTS']);
    expect(withEventTags(['telegram-signal', 'decision:d1', 'learn'], at, {})).toEqual(['telegram-signal', 'decision:d1', 'learn', 'EVENT:US_MIDTERM_RESULTS']);
    expect(withEventTags(['EVENT:US_MIDTERM_RESULTS'], at, {})).toEqual(['EVENT:US_MIDTERM_RESULTS']);
    expect(withEventTags(undefined, ist('2026-11-05T09:20:00'), {})).toEqual([]);
    const input = ['a'];
    withEventTags(input, at, {});
    expect(input).toEqual(['a']);
  });

  it('labels', () => {
    expect(eventLabel('US_MIDTERM_RESULTS')).toBe('US midterm results overnight');
    expect(eventLabel('RBI_POLICY')).toBe('rbi policy');
  });
});
