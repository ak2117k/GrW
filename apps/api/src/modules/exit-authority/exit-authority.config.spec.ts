import { parseAuthorityMode } from './exit-authority.config';

describe('parseAuthorityMode', () => {
  it('defaults to off', () => {
    expect(parseAuthorityMode({})).toBe('off');
  });

  it('reads live, trimmed and case-insensitive', () => {
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: ' LIVE ' })).toBe('live');
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: 'live' })).toBe('live');
  });

  it('treats anything unrecognised as off', () => {
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: 'shadow' })).toBe('off');
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: 'off' })).toBe('off');
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: '' })).toBe('off');
    expect(parseAuthorityMode({ TRADE_AGENT_AUTHORITY: 'true' })).toBe('off');
  });
});
