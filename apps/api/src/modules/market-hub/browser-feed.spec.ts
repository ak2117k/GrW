import {
  MAX_BROWSER_REFS_PER_SOCKET,
  browserOwner,
  browserPriority,
  parseFeedRefs,
  priceToBrowserTick,
  priceToDepth,
  priceToQuote,
} from './browser-feed';
import type { Price } from './hub.types';

const AT = Date.parse('2026-10-12T04:00:00.000Z'); // 09:30 IST
const OPT: Price = {
  ref: { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
  ltp: 121,
  at: AT,
  source: 'ws',
  volume: 9000,
  oi: 120_000,
  day: { open: 100, high: 125, low: 95, close: 110 },
  depth: { bids: [{ price: 120.95, qty: 75, orders: 3 }], asks: [{ price: 121.05, qty: 150, orders: 4 }] },
};

describe('parseFeedRefs', () => {
  it('takes the exchange the client sends (refs), upper-cased, with its symbol', () => {
    expect(parseFeedRefs({ refs: [{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }, { token: '2885', exchange: 'NSE' }] })).toEqual({
      refs: [
        { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
        { exchange: 'NSE', token: '2885', symbol: '2885' },
      ],
      bareTokens: 0,
    });
  });

  it('keeps the same token on two exchanges as two refs, and drops exact duplicates', () => {
    const { refs } = parseFeedRefs({
      refs: [
        { token: '1594', exchange: 'NSE' },
        { token: '1594', exchange: 'MCX' },
        { token: '1594', exchange: 'nse' },
      ],
    });
    expect(refs.map((r) => `${r.exchange}:${r.token}`)).toEqual(['NSE:1594', 'MCX:1594']);
  });

  it('accepts EXCHANGE:token strings; a bare token (old client bundle) means NSE and is counted', () => {
    expect(parseFeedRefs({ tokens: ['MCX:4321', '2885'] })).toEqual({
      refs: [
        { exchange: 'MCX', token: '4321', symbol: '4321' },
        { exchange: 'NSE', token: '2885', symbol: '2885' },
      ],
      bareTokens: 1,
    });
  });

  it('drops unknown exchanges, non-numeric and zero tokens, and junk', () => {
    expect(parseFeedRefs({ tokens: ['CDS:1', 'abc', '0', 42, null], refs: undefined }).refs).toEqual([]);
    expect(parseFeedRefs({ refs: [{ token: '1', exchange: 'XYZ' }, { token: 7, exchange: 'NSE' }, null] }).refs).toEqual([]);
    expect(parseFeedRefs(null)).toEqual({ refs: [], bareTokens: 0 });
  });

  it('refs win over tokens when both are sent', () => {
    expect(parseFeedRefs({ tokens: ['111'], refs: [{ token: '35001', exchange: 'NFO' }] }).refs).toEqual([
      { exchange: 'NFO', token: '35001', symbol: '35001' },
    ]);
  });

  it('is capped (bounded per socket)', () => {
    const many = Array.from({ length: MAX_BROWSER_REFS_PER_SOCKET + 20 }, (_, i) => ({ token: String(i + 1), exchange: 'NSE' }));
    expect(parseFeedRefs({ refs: many }).refs).toHaveLength(MAX_BROWSER_REFS_PER_SOCKET);
    expect(parseFeedRefs({ refs: many }, 3).refs).toHaveLength(3);
  });
});

describe('browserPriority / browserOwner', () => {
  it('maps purposes to the spec priorities and anything else to a viewed chart (4), never 0 or 1', () => {
    expect(browserPriority('context')).toBe(2);
    expect(browserPriority('watchlist')).toBe(3);
    expect(browserPriority('chart')).toBe(4);
    expect(browserPriority(undefined)).toBe(4);
    expect(browserPriority('positions')).toBe(4);
    expect(browserPriority('__proto__')).toBe(4);
    expect(browserPriority(0)).toBe(4);
  });

  it('names one owner per socket', () => {
    expect(browserOwner('abc')).toBe('browser:abc');
  });
});

describe('priceToBrowserTick', () => {
  it('is a Quote-compatible TickData: exchange, change vs the previous close, depth, receipt time', () => {
    const t = priceToBrowserTick(OPT);
    expect(t).toMatchObject({
      token: '35001',
      symbol: 'NIFTY26OCT25000CE',
      exchange: 'NFO',
      ltp: 121,
      open: 100,
      high: 125,
      low: 95,
      close: 110,
      volume: 9000,
      oi: 120_000,
      change: 11,
      at: AT,
      source: 'ws',
      depth: OPT.depth,
    });
    expect(t.changePercent).toBeCloseTo(10, 6);
    expect(t.timestamp).toEqual(new Date(AT));
  });

  it('carries no change when the broker reported no day bar (never a -100 % day)', () => {
    const bare: Price = { ...OPT, day: undefined, depth: undefined };
    const t = priceToBrowserTick(bare);
    expect(t).not.toHaveProperty('change');
    expect(t).not.toHaveProperty('changePercent');
    expect(t).not.toHaveProperty('depth');
    expect(t.close).toBe(0);
  });
});

describe('priceToQuote / priceToDepth', () => {
  it('builds the /quote Quote, preferring the caller’s symbol, with the price’s own timestamp', () => {
    const q = priceToQuote(OPT, 'NIFTY 25000 CE');
    expect(q).toMatchObject({ token: '35001', symbol: 'NIFTY 25000 CE', exchange: 'NFO', ltp: 121, close: 110, change: 11, oi: 120_000 });
    expect(q.timestamp).toEqual(new Date(AT));
    expect(priceToQuote(OPT).symbol).toBe('NIFTY26OCT25000CE');
  });

  it('a quote without a day bar has change 0, not a -100 % day', () => {
    const bare: Price = { ...OPT, day: undefined };
    expect(priceToQuote(bare)).toMatchObject({ close: 0, change: 0, changePercent: 0 });
  });

  it('builds the MarketDepth the depth card reads, and null without a book', () => {
    expect(priceToDepth(OPT)).toEqual({
      token: '35001',
      exchange: 'NFO',
      bids: [{ price: 120.95, qty: 75, orders: 3 }],
      asks: [{ price: 121.05, qty: 150, orders: 4 }],
      totalBidQty: 75,
      totalAskQty: 150,
      ts: AT,
    });
    const bare: Price = { ...OPT, depth: undefined };
    expect(priceToDepth(bare)).toBeNull();
  });
});
