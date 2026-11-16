import { MARKET_READ_FIELD_LINE, MARKET_READ_LINES, sentinelSystemPrompt } from './sentinel-system-prompt';

describe('correctness review F2/F3: flow.oiRead + indicators prompt lines (SENTINEL_MARKET_READ)', () => {
  const base = { cues: true, triggers: false, discipline: true, news: true } as const;
  it('off: the prompt is exactly the prompt without the switch', () => {
    expect(sentinelSystemPrompt({ ...base, marketRead: false })).toBe(sentinelSystemPrompt(base));
  });
  it('on: adds the field line and both reading lines, and nothing else', () => {
    const on = sentinelSystemPrompt({ ...base, marketRead: true });
    expect(on).toContain(MARKET_READ_FIELD_LINE);
    expect(on).toContain(MARKET_READ_LINES);
    expect(on.replace(MARKET_READ_FIELD_LINE, '').replace(MARKET_READ_LINES, '')).toBe(sentinelSystemPrompt(base));
  });
});
