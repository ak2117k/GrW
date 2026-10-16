import { newsContextBootLine, parseNewsContextConfig } from './news-context-config';

describe('parseNewsContextConfig', () => {
  it.each([
    // [NEWS_CONTEXT_V3, NEWS_EVENTS_V2_ENABLED, mode, computing, rendering]
    [undefined, 'observe', 'false', false, false],
    ['true', 'false', 'true', false, false],
    ['observe', 'observe', 'observe', true, false],
    ['true', 'observe', 'true', true, false],
    ['observe', 'true', 'observe', true, false],
    ['true', 'true', 'true', true, true],
    [' TRUE ', 'true', 'true', true, true],
    ['ture', 'true', 'false', false, false],
  ])('v3=%j v2=%j → mode %s computing %s rendering %s', (v3, v2, mode, computing, rendering) => {
    const c = parseNewsContextConfig({ NEWS_CONTEXT_V3: v3 as string | undefined, NEWS_EVENTS_V2_ENABLED: v2 });
    expect([c.mode, c.computing, c.rendering]).toEqual([mode, computing, rendering]);
  });

  it('v3 never computes when v2 is off', () => {
    expect(parseNewsContextConfig({ NEWS_CONTEXT_V3: 'true' })).toMatchObject({ mode: 'true', computing: false, rendering: false });
  });

  it('curator mode: exact words only; a typo is off and reported', () => {
    expect(parseNewsContextConfig({ NEWS_CURATOR_MODE: 'auto' }).curator).toBe('auto');
    expect(parseNewsContextConfig({ NEWS_CURATOR_MODE: ' Propose ' }).curator).toBe('propose');
    const c = parseNewsContextConfig({ NEWS_CURATOR_MODE: 'autp' });
    expect(c.curator).toBe('off');
    expect(c.problems).toEqual([expect.stringMatching(/NEWS_CURATOR_MODE="autp" is not off\|propose\|auto/)]);
  });

  it('defaults', () => {
    expect(parseNewsContextConfig({})).toEqual({
      mode: 'false', computing: false, rendering: false, curator: 'off', nightMaxCalls: 40, nightMaxInputTokens: 400000,
      profileMaxBuildsPerDay: 20, profileRefreshDays: 90, problems: [],
    });
  });

  it('out-of-range numbers fall back and are reported; 0 builds/day is legal', () => {
    const c = parseNewsContextConfig({ NEWS_LLM_NIGHT_MAX_CALLS: '500', NEWS_PROFILE_REFRESH_DAYS: '3', NEWS_PROFILE_MAX_BUILDS_PER_DAY: '0' });
    expect([c.nightMaxCalls, c.profileRefreshDays, c.profileMaxBuildsPerDay]).toEqual([40, 90, 0]);
    expect(c.problems).toHaveLength(2);
  });

  it('boot line', () => {
    expect(newsContextBootLine(parseNewsContextConfig({ NEWS_EVENTS_V2_ENABLED: 'observe', NEWS_CONTEXT_V3: 'observe', NEWS_CURATOR_MODE: 'propose' }))).toBe(
      '[news-ctx] v3=observe (computing) curator=propose caps=calls 40/night, input 400000/night, profiles 20/day refresh 90d',
    );
  });
});
