import type { HubPriceSource, HubPrices } from './hub-prices';
import type { InstrumentRef, Price, PriceResult } from './hub.types';
import { REST_OWNER, hubQuoteKey, serveDepthFromHub, serveQuotesFromHub } from './serve-browser';

const AT = 1_760_000_000_000;
const price = (exchange: InstrumentRef['exchange'], token: string, ltp: number, extra: Partial<Price> = {}): Price => ({
  ref: { exchange, token, symbol: token },
  ltp,
  at: AT,
  source: 'ws',
  day: { open: ltp, high: ltp, low: ltp, close: ltp - 10 },
  ...extra,
});

function sourceWith(answers: Record<string, PriceResult>, owner = 'owner') {
  const hub: HubPrices = {
    price: jest.fn((ref: InstrumentRef): PriceResult => answers[`${ref.exchange}:${ref.token}`] ?? { kind: 'unavailable', reason: 'never-priced' }),
    prices: jest.fn(),
    watch: jest.fn().mockResolvedValue(undefined),
    unwatch: jest.fn().mockResolvedValue(undefined),
    onPrice: jest.fn(() => () => undefined),
  };
  const source: HubPriceSource = {
    hubFor: jest.fn((userId: string | null, consumer) => (consumer === 'browser' && userId === owner ? hub : null)),
    record: jest.fn(),
  };
  return { hub, source };
}

describe('serveQuotesFromHub', () => {
  it('serves fresh prices as quotes keyed EXCHANGE:token, watching every ref at the given priority with the screen TTL', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500) } });
    const out = serveQuotesFromHub(source, 'owner', [{ token: '2885', exchange: 'nse', symbol: 'RELIANCE' }], { priority: 3, owner: REST_OWNER.watchlist });
    expect(hub.watch).toHaveBeenCalledWith([{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 3, 'rest:watchlist', 120_000);
    expect(hub.price).toHaveBeenCalledWith({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }, { maxAgeMs: 15_000 });
    expect(out.missing).toEqual([]);
    expect(out.quotes.get(hubQuoteKey('2885', 'NSE'))).toMatchObject({ symbol: 'RELIANCE', ltp: 1500, close: 1490, change: 10 });
    expect(source.record).toHaveBeenCalledWith('browser', 'hub', 1);
    expect(source.record).toHaveBeenCalledWith('browser', 'legacy', 0);
  });

  it('a never-priced, stale or market-closed instrument is missing (legacy): a closed-market price can be hours old', () => {
    const { source } = sourceWith({
      'NSE:1': { kind: 'stale', price: price('NSE', '1', 10), ageMs: 60_000 },
      'MCX:3': { kind: 'market-closed', price: price('MCX', '3', 30) },
    });
    const refs = [
      { token: '1', exchange: 'NSE' },
      { token: '2', exchange: 'NSE' }, // never priced
      { token: '3', exchange: 'MCX' },
    ];
    const out = serveQuotesFromHub(source, 'owner', refs, { priority: 4, owner: REST_OWNER.quote });
    expect(out.missing).toEqual([refs[0], refs[1], refs[2]]);
    expect(out.quotes.size).toBe(0);
    expect(source.record).toHaveBeenCalledWith('browser', 'hub', 0);
    expect(source.record).toHaveBeenCalledWith('browser', 'legacy', 3);
  });

  it('keys answers by EXCHANGE:token, so the same token on two exchanges is priced separately', () => {
    const { source } = sourceWith({
      'NSE:1594': { kind: 'fresh', price: price('NSE', '1594', 1700) },
      'MCX:1594': { kind: 'fresh', price: price('MCX', '1594', 7) },
    });
    const out = serveQuotesFromHub(source, 'owner', [{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }], { priority: 3, owner: REST_OWNER.watchlist });
    expect(out.quotes.get('NSE:1594')?.ltp).toBe(1700);
    expect(out.quotes.get('MCX:1594')?.ltp).toBe(7);
  });

  it('an exchange the hub does not speak is missing, and never watched', () => {
    const { hub, source } = sourceWith({});
    const out = serveQuotesFromHub(source, 'owner', [{ token: '1', exchange: 'CDS' }], { priority: 4, owner: REST_OWNER.quote });
    expect(out.missing).toEqual([{ token: '1', exchange: 'CDS' }]);
    expect(hub.watch).not.toHaveBeenCalled();
  });

  it('serves nothing for a user hubFor does not serve, and counts nothing', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500) } });
    const refs = [{ token: '2885', exchange: 'NSE' }];
    expect(serveQuotesFromHub(source, 'someone-else', refs, { priority: 4, owner: REST_OWNER.quote })).toEqual({ quotes: new Map(), missing: refs });
    expect(serveQuotesFromHub(null, 'owner', refs, { priority: 4, owner: REST_OWNER.quote })).toEqual({ quotes: new Map(), missing: refs });
    expect(hub.price).not.toHaveBeenCalled();
    expect(source.record).not.toHaveBeenCalled();
  });

  it('never throws: a throwing hubFor or price() means every ref is missing', () => {
    const refs = [{ token: '2885', exchange: 'NSE' }];
    const boom: HubPriceSource = { hubFor: () => { throw new Error('boom'); }, record: jest.fn() };
    expect(serveQuotesFromHub(boom, 'owner', refs, { priority: 4, owner: REST_OWNER.quote }).missing).toEqual(refs);
    const { hub, source } = sourceWith({});
    (hub.price as jest.Mock).mockImplementation(() => { throw new Error('book'); });
    expect(serveQuotesFromHub(source, 'owner', refs, { priority: 4, owner: REST_OWNER.quote }).missing).toEqual(refs);
  });
});

describe('serveDepthFromHub', () => {
  const book = { bids: [{ price: 1499.9, qty: 10, orders: 2 }], asks: [{ price: 1500.1, qty: 4, orders: 1 }] };

  it('serves a fresh price’s book, watching the ref at priority 4', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500, { depth: book }) } });
    expect(serveDepthFromHub(source, 'owner', { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' })).toEqual({
      token: '2885', exchange: 'NSE', bids: book.bids, asks: book.asks, totalBidQty: 10, totalAskQty: 4, ts: AT,
    });
    expect(hub.watch).toHaveBeenCalledWith([{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 4, 'rest:depth', 120_000);
  });

  it('is null (legacy) for a market-closed or stale price, a price without a book, another user, or no hub', () => {
    const { source } = sourceWith({
      'NSE:1': { kind: 'market-closed', price: price('NSE', '1', 10, { depth: book }) },
      'NSE:2': { kind: 'stale', price: price('NSE', '2', 10, { depth: book }), ageMs: 30_000 },
      'NSE:3': { kind: 'fresh', price: price('NSE', '3', 10) },
    });
    expect(serveDepthFromHub(source, 'owner', { token: '1', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'owner', { token: '2', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'owner', { token: '3', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'u2', { token: '1', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(null, 'owner', { token: '1', exchange: 'NSE' })).toBeNull();
  });
});
