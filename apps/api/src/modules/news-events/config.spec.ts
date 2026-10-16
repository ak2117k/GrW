import { parseNewsEventsConfig, newsEventsBootLine } from './config';

describe('parseNewsEventsConfig', () => {
  it.each([
    [undefined, 'false'], ['', 'false'], ['false', 'false'], [' TRUE ', 'true'], ['observe', 'observe'],
    ['Observe', 'observe'], ['yes', 'false'], ['1', 'false'], ['ture', 'false'],
  ])('NEWS_EVENTS_V2_ENABLED=%j → %s', (raw, mode) => {
    const c = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: raw as string | undefined });
    expect(c.mode).toBe(mode);
    expect(c.computing).toBe(mode !== 'false');
    expect(c.rendering).toBe(mode === 'true');
  });

  it('a typo is reported, never widened', () => {
    const c = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'ture' });
    expect(c.problems).toEqual([expect.stringMatching(/NEWS_EVENTS_V2_ENABLED="ture" is not false\|observe\|true/)]);
  });

  it('defaults', () => {
    expect(parseNewsEventsConfig({})).toEqual({
      mode: 'false', computing: false, rendering: false, nseAnnCadenceMin: 3, indexHours: 24, indexMaxItems: 5000,
      wakeCooldownMin: 5, eventWakeLeadMin: 15, eventsHorizonTradingDays: 3, problems: [],
    });
  });

  it('out-of-range and non-integer numbers fall back to the default and are reported', () => {
    const c = parseNewsEventsConfig({ NEWS_INDEX_HOURS: '2', NEWS_WAKE_COOLDOWN_MIN: '2.5', EVENT_WAKE_LEAD_MIN: '30' });
    expect(c.indexHours).toBe(24);
    expect(c.wakeCooldownMin).toBe(5);
    expect(c.eventWakeLeadMin).toBe(30);
    expect(c.problems).toHaveLength(2);
  });

  it('boot line names every value', () => {
    expect(newsEventsBootLine(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }))).toBe(
      '[news-events] mode=observe nseAnn=3m index=24h/5000 wakeCooldown=5m eventLead=15m horizon=3 trading days',
    );
  });
});
