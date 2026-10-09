import { describe, expect, it } from 'vitest';
import { depthFromTick, feedKey, indexRefs, isFeedSource, livePollMs, moreUrgent, quoteForItem, quoteForRefs, quoteFromTick, tickMatches, type WireTick } from './browser-feed';

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

const T = (over: Partial<WireTick> = {}): WireTick => ({
  token: '2885',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  ltp: 1500,
  open: 1490,
  high: 1505,
  low: 1488,
  close: 1480,
  volume: 1000,
  timestamp: '2026-10-12T04:00:00.000Z',
  at: Date.parse('2026-10-12T04:00:00.000Z'),
  change: 20,
  changePercent: 1.3514,
  ...over,
});
const PREV = { ltp: 1, open: 2, high: 3, low: 0.5, close: 1.5, change: -0.5, changePct: -33, isStale: true, loading: false };

describe('quoteFromTick', () => {
  it('takes the tick’s LTP, day bar and change', () => {
    expect(quoteFromTick(PREV, T())).toEqual({ ...PREV, ltp: 1500, open: 1490, high: 1505, low: 1488, close: 1480, change: 20, changePct: 1.3514 });
  });

  it('keeps the previous field where the tick reports 0, and derives change from the close when the tick has none', () => {
    const next = quoteFromTick({ ...PREV, close: 1480 }, T({ open: 0, high: 0, low: 0, close: 0, change: undefined, changePercent: undefined }));
    expect(next).toMatchObject({ ltp: 1500, open: 2, high: 3, low: 0.5, close: 1480, change: 20 });
    expect(next.changePct).toBeCloseTo((20 / 1480) * 100, 6);
  });

  it('returns the same reference for a tick without a usable LTP', () => {
    expect(quoteFromTick(PREV, T({ ltp: 0 }))).toBe(PREV);
  });
});

describe('depthFromTick', () => {
  it('builds the MarketDepth the card renders, with totals and the tick’s receipt time', () => {
    const d = depthFromTick(T({ depth: { bids: [{ price: 1499.9, qty: 10, orders: 2 }], asks: [{ price: 1500.1, qty: 4, orders: 1 }, { price: 1500.2, qty: 6, orders: 1 }] } }));
    expect(d).toEqual({
      token: '2885',
      exchange: 'NSE',
      bids: [{ price: 1499.9, qty: 10, orders: 2 }],
      asks: [{ price: 1500.1, qty: 4, orders: 1 }, { price: 1500.2, qty: 6, orders: 1 }],
      totalBidQty: 10,
      totalAskQty: 10,
      ts: Date.parse('2026-10-12T04:00:00.000Z'),
    });
  });

  it('is undefined for a tick with no book, so the last ladder stays', () => {
    expect(depthFromTick(T())).toBeUndefined();
  });
});

describe('quoteForItem', () => {
  const item = { symbol: 'RELIANCE', token: '2885', exchange: 'NSE' };

  it('builds the store Quote under the watchlist item’s own symbol', () => {
    expect(quoteForItem(item, T({ symbol: 'RELIANCE-EQ' }))).toMatchObject({ symbol: 'RELIANCE', token: '2885', exchange: 'NSE', ltp: 1500, change: 20, changePercent: 1.3514 });
  });

  it('is null for another exchange’s same token, or a tick without a change (it would clobber the row’s change)', () => {
    expect(quoteForItem(item, T({ exchange: 'MCX' }))).toBeNull();
    expect(quoteForItem(item, T({ change: undefined }))).toBeNull();
    expect(quoteForItem(item, T({ ltp: 0 }))).toBeNull();
  });
});

describe('quoteForRefs', () => {
  const refs = [
    { token: '99926000', exchange: 'NSE', symbol: 'NIFTY' },
    { token: '99919000', exchange: 'BSE', symbol: 'SENSEX' },
  ];
  const idx = (over: Partial<WireTick> = {}) => T({ token: '99926000', symbol: 'Nifty 50', exchange: 'NSE', ...over });

  it('builds the store Quote under the matching index ref’s own symbol', () => {
    expect(quoteForRefs(refs, idx())).toMatchObject({ symbol: 'NIFTY', token: '99926000', exchange: 'NSE', ltp: 1500, change: 20 });
  });

  it('is null for the same token on another exchange', () => {
    expect(quoteForRefs(refs, idx({ exchange: 'MCX' }))).toBeNull();
  });

  it('is null for a token no ref holds (a position, track or REST-only watch on the owner’s room)', () => {
    expect(quoteForRefs(refs, T())).toBeNull();
  });

  it('is null for a tick without a change, a non-positive LTP, or junk', () => {
    expect(quoteForRefs(refs, idx({ change: undefined }))).toBeNull();
    expect(quoteForRefs(refs, idx({ ltp: 0 }))).toBeNull();
    expect(quoteForRefs(refs, null)).toBeNull();
    expect(quoteForRefs([], idx())).toBeNull();
  });

  it('skips a ref without a symbol', () => {
    expect(quoteForRefs([{ token: '99926000', exchange: 'NSE' }], idx())).toBeNull();
  });
});

describe('indexRefs', () => {
  it('reads token, exchange and symbol from the /indices rows and skips malformed ones', () => {
    expect(
      indexRefs([
        { key: 'NIFTY_50', symbol: 'NIFTY', token: '99926000', exchange: 'NSE', quote: null },
        { key: 'SENSEX', symbol: 'SENSEX', token: '99919000', exchange: 'BSE' },
        { key: 'BAD', symbol: 'X' },
      ]),
    ).toEqual([
      { token: '99926000', exchange: 'NSE', symbol: 'NIFTY' },
      { token: '99919000', exchange: 'BSE', symbol: 'SENSEX' },
    ]);
    expect(indexRefs(undefined)).toEqual([]);
  });
});
