import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { DeskMarketAdapter, liveFeedGate, nextBarReadyAt } from './desk-market.adapter';

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

/** Session 1-minute bars (NSE 09:15–15:30 IST) every minute from 11-26 09:15 IST up to (not including) `until`. */
function onesUntil(until: number, close = (i: number) => 25600 + i * 0.05) {
  const out: Array<{ ts: number; open: number; high: number; low: number; close: number }> = [];
  let i = 0;
  for (let ts = Date.parse('2026-11-26T03:45:00Z'); ts < until; ts += MIN) {
    const m = ((((ts + 330 * MIN) % 86_400_000) + 86_400_000) % 86_400_000) / MIN;
    if (m < 555 || m >= 930) continue;
    const c = close(i++);
    out.push({ ts, open: c, high: c + 1, low: c - 1, close: c });
  }
  return out;
}

describe('liveFeedGate (Angel live-feed bars, trusted only when they check out)', () => {
  const ones = onesUntil(T0);
  const ltp = ones[ones.length - 1].close;

  it('passes fresh, complete bars that agree with the live price', () => {
    const v = liveFeedGate(ones, 'NSE', T0, ltp);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.bars.every((b) => (b.ts - Date.parse('2026-11-26T03:45:00Z')) % (15 * MIN) === 0)).toBe(true);
  });

  it('rejects a frozen line while the venue is open (newest bar > 3 min old)', () => {
    const v = liveFeedGate(onesUntil(T0 - 10 * MIN), 'NSE', T0, ltp);
    expect(v).toMatchObject({ ok: false, reason: 'live feed stale' });
  });

  it('rejects when the bars disagree with the live price or there is no live price', () => {
    expect(liveFeedGate(ones, 'NSE', T0, ltp * 1.01)).toMatchObject({ ok: false });
    expect(liveFeedGate(ones, 'NSE', T0, null)).toMatchObject({ ok: false, reason: 'no live price to verify against' });
  });

  it('rejects a last 15m bar built from a gappy minute record', () => {
    // At 11:10 IST the last closed NSE bucket is 10:45–11:00; drop 10:40–10:50 so it holds only 10 minutes.
    const gappy = ones.filter((b) => !(b.ts >= Date.parse('2026-11-27T05:10:00Z') && b.ts < Date.parse('2026-11-27T05:20:00Z')));
    expect(liveFeedGate(gappy, 'NSE', T0, ltp)).toMatchObject({ ok: false, reason: 'last 15m bar built from 10/15 minutes' });
  });

  it('rejects when there are too few closed 15m bars for the trend', () => {
    const recent = ones.filter((b) => b.ts >= Date.parse('2026-11-27T03:45:00Z'));
    expect(liveFeedGate(recent, 'NSE', T0, ltp)).toMatchObject({ ok: false, reason: expect.stringMatching(/closed 15m bars/) });
  });
});

describe('DeskMarketAdapter prefers the live feed over the historical API', () => {
  function makeLive(rows: ReturnType<typeof onesUntil>, ltp: number | null) {
    const market = {
      underlyingRef: jest.fn(async () => ref),
      ltps: jest.fn(async () => new Map<string, number>(ltp === null ? [] : [[`NSE:${ref.token}`, ltp]])),
      bars15m: jest.fn(async () => barsUntil(T0)),
      master: jest.fn(async () => null),
      isOpen: jest.fn(() => true),
      minutesToClose: jest.fn(() => 60),
    };
    const prisma = { $queryRaw: jest.fn(async () => rows.map((r) => ({ ...r, ts: new Date(r.ts), volume: 0 }))) };
    const a = new DeskMarketAdapter(market as never, { getLevels: () => null } as never, prisma as never);
    a.clock = () => T0;
    return { a, market, prisma };
  }

  it('good live-feed bars → no historical call; trend and day come from the feed', async () => {
    const rows = onesUntil(T0);
    const { a, market } = makeLive(rows, rows[rows.length - 1].close);
    expect(await a.trend15m('NIFTY', new Date(T0))).toMatch(/^UP \(15m close/);
    const day = await a.day('NIFTY', new Date(T0));
    expect(day?.open).toBe(rows.find((r) => r.ts >= Date.parse('2026-11-27T03:45:00Z'))!.open);
    expect(market.bars15m).not.toHaveBeenCalled();
  });

  it('live-feed bars that fail the gate → the Angel historical API, as before', async () => {
    const rows = onesUntil(T0);
    const { a, market } = makeLive(rows, null);
    await a.trend15m('NIFTY', new Date(T0));
    expect(market.bars15m).toHaveBeenCalledTimes(1);
  });
});
