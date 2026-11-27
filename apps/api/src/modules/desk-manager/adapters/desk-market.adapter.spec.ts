import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { DeskMarketAdapter, nextBarReadyAt } from './desk-market.adapter';

const MIN = 60_000;
// 2026-11-27 11:10:00 IST = 05:40:00Z (a 15m close was 11:00 IST, the next is 11:15 IST).
const T0 = Date.parse('2026-11-27T05:40:00Z');
const ref = { exchange: 'NSE', token: '99926000', symbol: 'Nifty 50' };

/** 15m bars every 15 minutes from 11-26 09:15 IST up to (not including) `until`. */
function barsUntil(until: number): Bar15m[] {
  const out: Bar15m[] = [];
  for (let ts = Date.parse('2026-11-26T03:45:00Z'); ts < until; ts += 15 * MIN) out.push({ ts, open: 100, high: 101, low: 99, close: 100 + out.length * 0.1 });
  return out;
}

function make(fetch: (from: Date, to: Date) => Promise<Bar15m[]>) {
  const market = {
    underlyingRef: jest.fn(async () => ref),
    ltps: jest.fn(async () => new Map<string, number>()),
    bars15m: jest.fn(async (_r: unknown, from: Date, to: Date) => fetch(from, to)),
    master: jest.fn(async () => null),
    isOpen: jest.fn(() => true),
    minutesToClose: jest.fn(() => 60),
  };
  const levelBooks = { getLevels: jest.fn(() => null) };
  const a = new DeskMarketAdapter(market as never, levelBooks as never, {} as never);
  let now = T0;
  a.clock = () => now;
  return { a, market, setNow: (t: number) => (now = t) };
}

describe('nextBarReadyAt', () => {
  it('is the next 15m close + 20 s publish grace; a fetch inside the grace is due at that same close + grace', () => {
    expect(nextBarReadyAt(T0)).toBe(Date.parse('2026-11-27T05:45:20Z')); // 11:10 → 11:15:20 IST
    expect(nextBarReadyAt(Date.parse('2026-11-27T05:45:05Z'))).toBe(Date.parse('2026-11-27T05:45:20Z')); // 11:15:05 → 11:15:20
    expect(nextBarReadyAt(Date.parse('2026-11-27T05:45:20Z'))).toBe(Date.parse('2026-11-27T06:00:20Z'));
  });
});

describe('DeskMarketAdapter 15m bars (straight from Angel, one fetch per closed bar)', () => {
  it('day(), trend15m() and priceAt() share ONE Angel fetch inside a bar', async () => {
    const { a, market } = make(async () => barsUntil(T0));
    const now = new Date(T0);
    await a.day('NIFTY', now);
    await a.trend15m('NIFTY', now);
    await a.priceAt('NIFTY', new Date(T0 - 30 * MIN));
    await a.trend15m('nifty', new Date(T0 + 3 * MIN));
    expect(market.bars15m).toHaveBeenCalledTimes(1);
  });

  it('asks Angel again only after the next 15m bar has closed and been published', async () => {
    const { a, market, setNow } = make(async (_f, to) => barsUntil(to.getTime()));
    await a.trend15m('NIFTY', new Date(T0));
    setNow(Date.parse('2026-11-27T05:45:10Z')); // 11:15:10 IST: closed, not yet past the grace
    await a.trend15m('NIFTY', new Date(Date.parse('2026-11-27T05:45:10Z')));
    expect(market.bars15m).toHaveBeenCalledTimes(1);
    setNow(Date.parse('2026-11-27T05:45:30Z')); // 11:15:30 IST
    await a.trend15m('NIFTY', new Date(Date.parse('2026-11-27T05:45:30Z')));
    // A refresh with cached bars serves the cached ones while it runs; let it land.
    await new Promise((r) => setImmediate(r));
    expect(market.bars15m).toHaveBeenCalledTimes(2);
  });

  it('a fetch slower than the packet box still fills the cache for the next run', async () => {
    let release!: (b: Bar15m[]) => void;
    const { a, market } = make(() => new Promise<Bar15m[]>((r) => (release = r)));
    // The packet's box gives up on this read (like the 3 s timeout); the Angel answer arrives afterwards.
    const first = a.trend15m('NIFTY', new Date(T0));
    const boxed = await Promise.race([first.then(() => 'answered'), new Promise((r) => setTimeout(() => r('timed out'), 20))]);
    expect(boxed).toBe('timed out');
    release(barsUntil(T0));
    await first;
    const day = await a.day('NIFTY', new Date(T0 + MIN));
    expect(day?.open).toBe(100);
    expect(market.bars15m).toHaveBeenCalledTimes(1);
  });

  it('an empty or failed Angel answer is retried after a minute, not held until the next bar', async () => {
    let calls = 0;
    const { a, market, setNow } = make(async () => {
      calls++;
      if (calls === 1) throw new Error('AB1021 too many requests');
      return barsUntil(T0);
    });
    expect(await a.trend15m('NIFTY', new Date(T0))).toBeNull();
    setNow(T0 + 30_000);
    await a.trend15m('NIFTY', new Date(T0 + 30_000));
    expect(market.bars15m).toHaveBeenCalledTimes(1);
    setNow(T0 + 61_000);
    expect(await a.trend15m('NIFTY', new Date(T0 + 61_000))).toMatch(/^(UP|DOWN|FLAT) \(15m close/);
    expect(market.bars15m).toHaveBeenCalledTimes(2);
  });

  it('only CLOSED bars are used: the forming bar never enters the trend or the day', async () => {
    const forming = { ts: Date.parse('2026-11-27T05:30:00Z'), open: 1, high: 999, low: 1, close: 999 }; // 11:00–11:15 IST, open at 11:10
    const { a } = make(async () => [...barsUntil(Date.parse('2026-11-27T05:30:00Z')), forming]);
    const day = await a.day('NIFTY', new Date(T0));
    expect(day?.high).toBe(101);
    expect(await a.trend15m('NIFTY', new Date(T0))).not.toContain('999');
  });
});
