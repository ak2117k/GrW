import { LiveSetupWatchMarket } from './setup-watch.market';

const NOW = new Date('2026-11-25T05:30:00Z');
const MASTER = [{ exch_seg: 'NSE', symbol: 'DABUR-EQ', token: '772', name: 'DABUR' }];
const VOCAB = { names: new Map(), classOf: new Map([['DABUR', 'STOCK'], ['CRUDEOIL', 'COMMODITY']]) };

function make(o: { master?: () => Promise<readonly unknown[] | null>; vocab?: (() => Promise<unknown>) | null } = {}) {
  return new LiveSetupWatchMarket({
    moduleRef: null,
    quotes: { resolveQuotes: jest.fn(async () => new Map()) },
    bars: null,
    master: { rows: o.master ?? (async () => MASTER) },
    vocab: o.vocab === null ? null : { get: (o.vocab ?? (async () => VOCAB)) as never },
    ownerUserId: 'owner-1',
    clock: { isOpen: () => true, minutesToClose: () => 120 },
  });
}

describe('LiveSetupWatchMarket.underlyingRef — null only when both are loaded and nothing matched', () => {
  it('both loaded: the NSE cash line; an unknown name → null', async () => {
    expect(await make().underlyingRef('DABUR', NOW)).toEqual({ exchange: 'NSE', token: '772', symbol: 'DABUR' });
    expect(await make().underlyingRef('NOSUCH', NOW)).toBeNull();
  });

  it('master failing / not loaded / empty → throws (the watch waits), never null', async () => {
    await expect(make({ master: async () => Promise.reject(new Error('boom')) }).underlyingRef('DABUR', NOW)).rejects.toThrow(/instrument master unavailable: boom/);
    await expect(make({ master: async () => null }).underlyingRef('DABUR', NOW)).rejects.toThrow(/instrument master not loaded/);
    await expect(make({ master: async () => [] }).underlyingRef('DABUR', NOW)).rejects.toThrow(/instrument master not loaded/);
  });

  it('vocabulary failing / empty / not wired → throws (an MCX name never falls through to an NSE lookup)', async () => {
    await expect(make({ vocab: async () => Promise.reject(new Error('db')) }).underlyingRef('CRUDEOIL', NOW)).rejects.toThrow(/vocabulary unavailable: db/);
    await expect(make({ vocab: async () => ({ names: new Map(), classOf: new Map() }) }).underlyingRef('CRUDEOIL', NOW)).rejects.toThrow(/vocabulary not loaded/);
    await expect(make({ vocab: null }).underlyingRef('DABUR', NOW)).rejects.toThrow(/vocabulary not wired/);
  });

  it('an index needs neither (resolved even with both down)', async () => {
    const r = await make({ master: async () => Promise.reject(new Error('down')), vocab: async () => Promise.reject(new Error('down')) }).underlyingRef('NIFTY', NOW);
    expect(r).toMatchObject({ exchange: 'NSE', symbol: 'NIFTY' });
  });

  it('a failure is not cached: the next call after the master loads resolves', async () => {
    let loaded = false;
    const m = make({ master: async () => (loaded ? MASTER : null) });
    await expect(m.underlyingRef('DABUR', NOW)).rejects.toThrow();
    loaded = true;
    expect(await m.underlyingRef('DABUR', NOW)).toMatchObject({ token: '772' });
  });
});
