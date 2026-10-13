import type { ModuleRef } from '@nestjs/core';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { HUB_PRICE_SOURCE } from '../../market-hub/hub-prices';
import { FakeHub, fakeHubSource } from '../execution/testing/fake-hub';
import type { CoreCandles } from '../market/core-candles';
import { atrFrom, ENTRY_PRICE_WAIT_MS, EntryMarket, intakeOwner } from './entry-market';
import { ist } from './testing/intake-fixtures';

const NOW = ist('2026-10-13', '10:30');
const REF = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE-EQ' };
const bar = (i: number, close: number): HubCandle => ({ ts: NOW.getTime() - (30 - i) * 300_000, open: close, high: close + 2, low: close - 2, close, volume: 100 });

function setup(opts: { served?: boolean; candles?: CoreCandles['read'] } = {}) {
  const hub = new FakeHub();
  const source = fakeHubSource(opts.served === false ? {} : { user_A: hub });
  const moduleRef = { get: (token: string) => (token === HUB_PRICE_SOURCE ? source : (() => { throw new Error('none'); })()) };
  const candles = { read: opts.candles ?? jest.fn().mockResolvedValue({ ok: false, reason: 'hub candles are off' }) } as unknown as CoreCandles;
  const market = new EntryMarket(moduleRef as unknown as ModuleRef, candles);
  // Test seam: sleeping advances the fake clock instead of waiting.
  Object.assign(market, { sleep: async (ms: number) => { jest.setSystemTime(Date.now() + ms); } });
  return { hub, market, candles };
}

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

describe('EntryMarket.freshPrice (ruling J6)', () => {
  it('a user the hub does not serve has no price source (fail closed)', async () => {
    const { market } = setup({ served: false });
    expect(await market.freshPrice('user_A', REF, intakeOwner('i1'))).toMatchObject({ ok: false, reason: 'NO_PRICE_SOURCE' });
  });

  it('watches the ref at priority 1 under core-intake:<intentId> and returns a fresh price at once', async () => {
    const { hub, market } = setup();
    hub.setFresh({ ref: REF, ltp: 501.5, at: Date.now(), source: 'ws' });
    expect(await market.freshPrice('user_A', REF, intakeOwner('i1'))).toEqual({ ok: true, ltp: 501.5, at: NOW.getTime() });
    expect(hub.watches).toEqual([{ key: 'NSE:2885', priority: 1, owner: 'core-intake:i1' }]);
  });

  it(`waits up to ${ENTRY_PRICE_WAIT_MS} ms for the first fresh price, then gives up`, async () => {
    const { hub, market } = setup();
    let polls = 0;
    Object.assign(market, {
      sleep: async (ms: number) => {
        polls += 1;
        jest.setSystemTime(Date.now() + ms);
        if (polls === 3) hub.setFresh({ ref: REF, ltp: 499, at: Date.now(), source: 'quote' });
      },
    });
    expect(await market.freshPrice('user_A', REF, 'o')).toMatchObject({ ok: true, ltp: 499 });
    const { market: never } = setup();
    expect(await never.freshPrice('user_A', REF, 'o')).toMatchObject({ ok: false, reason: 'NO_FRESH_PRICE' });
    expect(Date.now() - NOW.getTime()).toBeGreaterThanOrEqual(ENTRY_PRICE_WAIT_MS);
  });

  it('waitMs 0 answers from what the hub holds now; release unwatches the owner', async () => {
    const { hub, market } = setup();
    expect(await market.freshPrice('user_A', REF, 'o', 0)).toMatchObject({ ok: false, reason: 'NO_FRESH_PRICE' });
    market.release('user_A', REF, 'o');
    expect(hub.unwatches).toEqual([{ key: 'NSE:2885', owner: 'o' }]);
  });
});

describe('EntryMarket.atr (O7) and atrFrom', () => {
  it('a fixed stop needs no ATR; a timeframe the hub does not build is none', async () => {
    const { market } = setup();
    expect(await market.atr(REF, { kind: 'fixedPct', pct: 1.5 }, NOW)).toEqual({ atr: null, source: 'none', detail: 'fixed stop' });
    expect((await market.atr(REF, { kind: 'atr', period: 14, timeframe: '3m', multiple: 1, minPct: 0.5, maxPct: 2 }, NOW)).source).toBe('none');
  });

  it('unavailable candles are none with the reason; enough candles give the silo ATR over 3 days of 5m bars', async () => {
    const off = setup();
    expect(await off.market.atr(REF, { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 }, NOW)).toEqual({ atr: null, source: 'none', detail: 'hub candles are off' });
    const read = jest.fn().mockResolvedValue({ ok: true, candles: Array.from({ length: 30 }, (_, i) => bar(i, 500)), complete: true });
    const on = setup({ candles: read });
    const r = await on.market.atr(REF, { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 }, NOW);
    expect(r.source).toBe('hub');
    expect(r.atr).toBeCloseTo(4, 5); // every bar spans high − low = 4 with flat closes
    expect(read).toHaveBeenCalledWith(REF, '5m', new Date(NOW.getTime() - 3 * 86_400_000), NOW);
  });

  it('atrFrom needs period + 1 bars', () => {
    expect(atrFrom(Array.from({ length: 14 }, (_, i) => bar(i, 500)), 14)).toBeNull();
    expect(atrFrom(Array.from({ length: 15 }, (_, i) => bar(i, 500)), 14)).toBeCloseTo(4, 5);
  });
});
