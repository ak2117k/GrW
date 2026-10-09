import { describe, expect, it } from 'vitest';
import { feedKey, isFeedSource, livePollMs, moreUrgent, tickMatches } from './browser-feed';

describe('feedKey', () => {
  it('is EXCHANGE:token, upper-cased, never the token alone', () => {
    expect(feedKey({ token: '35001', exchange: 'nfo' })).toBe('NFO:35001');
    expect(feedKey({ token: '1594', exchange: 'NSE' })).not.toBe(feedKey({ token: '1594', exchange: 'MCX' }));
  });
});

describe('livePollMs', () => {
  it('is off only for a hub-served, Live feed', () => {
    expect(livePollMs(3000, { source: 'hub', health: 'live' })).toBe(false);
  });

  it('keeps today’s cadence as the fallback for a stale or offline hub feed, a legacy feed, or before the server said', () => {
    expect(livePollMs(3000, { source: 'hub', health: 'stale' })).toBe(3000);
    expect(livePollMs(3000, { source: 'hub', health: 'offline' })).toBe(3000);
    expect(livePollMs(2000, { source: 'legacy', health: 'live' })).toBe(2000);
    expect(livePollMs(5000, { source: null, health: 'live' })).toBe(5000);
  });
});

describe('tickMatches', () => {
  const tick = { token: '35001', exchange: 'NFO', symbol: 'X', ltp: 1, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: '' };

  it('needs the token to agree, and the exchange to agree when the tick has one', () => {
    expect(tickMatches(tick, '35001', 'NFO')).toBe(true);
    expect(tickMatches(tick, '35001', 'nfo')).toBe(true);
    expect(tickMatches(tick, '35001', 'MCX')).toBe(false);
    expect(tickMatches(tick, '35002', 'NFO')).toBe(false);
  });

  it('a tick without an exchange (an old server) matches on token alone; junk never matches', () => {
    const bare = { ...tick, exchange: undefined };
    expect(tickMatches(bare, '35001', 'NFO')).toBe(true);
    expect(tickMatches(null, '35001', 'NFO')).toBe(false);
    expect(tickMatches('tick', '35001', 'NFO')).toBe(false);
  });
});

describe('isFeedSource', () => {
  it('accepts only hub and legacy', () => {
    expect(isFeedSource('hub')).toBe(true);
    expect(isFeedSource('legacy')).toBe(true);
    expect(isFeedSource('HUB')).toBe(false);
    expect(isFeedSource(undefined)).toBe(false);
  });
});

describe('moreUrgent', () => {
  it('ranks context over watchlist over chart (lower hub priority is more urgent), strictly', () => {
    expect(moreUrgent('context', 'watchlist')).toBe(true);
    expect(moreUrgent('watchlist', 'chart')).toBe(true);
    expect(moreUrgent('context', 'chart')).toBe(true);
    expect(moreUrgent('chart', 'watchlist')).toBe(false);
    expect(moreUrgent('watchlist', 'context')).toBe(false);
    expect(moreUrgent('watchlist', 'watchlist')).toBe(false);
  });
});
