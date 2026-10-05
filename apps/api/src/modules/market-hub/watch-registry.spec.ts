import { WatchRegistry } from './watch-registry';
import { allocateSlots } from './slot-allocator';
import type { InstrumentRef } from './hub.types';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: `S${token}`,
});

describe('WatchRegistry', () => {
  it('uses the most urgent priority across owners', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 3, 'ui', 0, 120_000);
    reg.watch(ref('1'), 0, 'positions', 0);
    expect(reg.entries()[0].priority).toBe(0);
    reg.unwatch(ref('1'), 'positions');
    expect(reg.entries()[0].priority).toBe(3);
  });

  it('expires TTL watches and reports the change', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 4, 'chart', 0, 120_000);
    reg.watch(ref('2'), 2, 'context', 0); // no TTL: never expires
    expect(reg.expire(119_999)).toBe(false);
    expect(reg.expire(120_001)).toBe(true);
    expect(reg.entries().map((e) => e.ref.token)).toEqual(['2']);
  });

  it('renewing a TTL watch keeps it alive', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 4, 'chart', 0, 120_000);
    reg.watch(ref('1'), 4, 'chart', 100_000, 120_000);
    expect(reg.expire(150_000)).toBe(false);
  });
});

describe('allocateSlots', () => {
  it('gives live slots by priority, then first-watch time', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('viewed'), 4, 'chart', 0);
    reg.watch(ref('pos'), 0, 'positions', 5);
    reg.watch(ref('nifty'), 2, 'context', 1);
    const a = allocateSlots(reg.entries(), 2);
    expect(a.live.map((e) => e.ref.token)).toEqual(['pos', 'nifty']);
    expect(a.nearLive.map((e) => e.ref.token)).toEqual(['viewed']);
    expect(a.demoted).toBe(1);
    expect(a.criticalOverflow).toEqual([]);
  });

  it('reports P0/P1 entries that did not fit as critical overflow', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('pos'), 0, 'positions', 0);
    reg.watch(ref('und'), 1, 'positions', 0);
    const a = allocateSlots(reg.entries(), 1);
    expect(a.live.map((e) => e.ref.token)).toEqual(['pos']);
    expect(a.criticalOverflow.map((e) => e.ref.token)).toEqual(['und']);
  });

  it('keeps the same token on two exchanges as two entries', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1', 'NSE'), 3, 'w', 0);
    reg.watch(ref('1', 'MCX'), 3, 'w', 0);
    expect(allocateSlots(reg.entries(), 50).live).toHaveLength(2);
  });
});
