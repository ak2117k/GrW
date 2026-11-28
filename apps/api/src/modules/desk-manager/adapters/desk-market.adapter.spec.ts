import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { DeskMarketAdapter, liveFeedGate, nextBarReadyAt, nextPrewarmAt } from './desk-market.adapter';

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

// ---- W4 (2026-11-28): shared bar cache, pre-warm, level books for every underlying, VWAP from the future ----

const IST = (s: string) => Date.parse(`${s}+05:30`);
/** NSE session 15m bars (09:15–15:15 starts) for each IST day, with a per-bar volume. */
function sessionBars(days: string[], until: number, vol = (_ts: number) => 0, px = (i: number) => 100 + i) {
  const out: Array<Bar15m & { volume: number }> = [];
  for (const d of days) {
    for (let ts = IST(`${d}T09:15:00`); ts < IST(`${d}T15:30:00`) && ts < until; ts += 15 * MIN) {
      const c = px(out.length);
      out.push({ ts, open: c, high: c + 2, low: c - 2, close: c, volume: vol(ts) });
    }
  }
  return out;
}

const NIFTY_FUT = { exchange: 'NFO', token: '35001', symbol: 'NIFTY30DEC26FUT' };
const MASTER = [
  { token: '35001', symbol: 'NIFTY30DEC26FUT', name: 'NIFTY', expiry: '30DEC2026', strike: '-1', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
  { token: '35002', symbol: 'NIFTY26JAN27FUT', name: 'NIFTY', expiry: '26JAN2027', strike: '-1', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
];

function makeW4(opts: {
  refs?: Record<string, typeof ref>;
  bars?: (r: { exchange: string; token: string }) => Array<Bar15m & { volume?: number }>;
  daily?: (r: { exchange: string; token: string }) => Array<{ day: string; high: number; low: number; close: number }>;
  book?: unknown;
  open?: boolean;
  mode?: 'off' | 'shadow' | 'live';
}) {
  const refs = opts.refs ?? { NIFTY: ref };
  const market = {
    underlyingRef: jest.fn(async (u: string) => refs[u] ?? null),
    ltps: jest.fn(async () => new Map<string, number>()),
    bars15m: jest.fn(async () => [] as Bar15m[]),
    master: jest.fn(async () => MASTER),
    isOpen: jest.fn(() => opts.open ?? true),
    minutesToClose: jest.fn(() => 60),
  };
  const info = {
    daily: jest.fn(async (exchange: string, token: string) => (opts.daily ? opts.daily({ exchange, token }) : [])),
    intraday15m: jest.fn(async (exchange: string, token: string) => (opts.bars ? opts.bars({ exchange, token }) : [])),
  };
  const moduleRef = { get: jest.fn(() => info) };
  const levelBooks = { getLevels: jest.fn(() => opts.book ?? null) };
  const cfg = { mode: opts.mode ?? 'shadow' };
  const a = new DeskMarketAdapter(market as never, levelBooks as never, {} as never, cfg as never, moduleRef as never);
  let now = T0;
  a.clock = () => now;
  return { a, market, info, setNow: (t: number) => (now = t) };
}

describe('W4 shared 15m bar cache (one fetch per (exchange, token) per closed bar)', () => {
  it('two underlyings on the same line share one fetch; bars15mOf serves any other caller from the same cache', async () => {
    const { a, info } = makeW4({ refs: { NIFTY: ref, 'NIFTY 50': ref }, bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0) });
    await a.trend15m('NIFTY', new Date(T0));
    await a.day('NIFTY 50', new Date(T0));
    const shared = await a.bars15mOf(ref);
    expect(shared.length).toBeGreaterThan(20);
    expect(info.intraday15m).toHaveBeenCalledTimes(1);
  });

  it('a historical answer missing the last closed bar (Angel publish lag) is retried after a minute', async () => {
    // At 11:10 IST the last closed bar is 10:45–11:00; the answer stops at 10:30–10:45.
    const { a, info, setNow } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], IST('2026-11-27T10:45:00')) });
    await a.trend15m('NIFTY', new Date(T0));
    setNow(T0 + 61_000);
    await a.trend15m('NIFTY', new Date(T0 + 61_000));
    await new Promise((r) => setImmediate(r));
    expect(info.intraday15m).toHaveBeenCalledTimes(2);
  });

  it('the publish-lag retry is spent ONCE per closed bar; a second short answer waits for the next bar', async () => {
    const { a, info, setNow } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], IST('2026-11-27T10:45:00')) });
    const read = async (t: number) => {
      setNow(t);
      await a.trend15m('NIFTY', new Date(t));
      await new Promise((r) => setImmediate(r));
    };
    await read(T0);
    await read(T0 + 61_000); // the one early retry
    await read(T0 + 122_000);
    await read(T0 + 183_000);
    expect(info.intraday15m).toHaveBeenCalledTimes(2);
    await read(Date.parse('2026-11-27T05:45:30Z')); // next bar published: asked again
    expect(info.intraday15m).toHaveBeenCalledTimes(3);
  });
});

describe('W4 pre-warm (boot, venue open, every closed bar)', () => {
  it('pre-warms the configured list and the last packet underlyings, so a run never waits on a cold fetch', async () => {
    const refs = { NIFTY: ref, RELIANCE: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' } };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { a, info } = makeW4({ refs, bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0) });
    info.intraday15m.mockImplementation(async () => {
      await gate;
      return sessionBars(['2026-11-26', '2026-11-27'], T0);
    });
    // RELIANCE was in the last packet (read once); NIFTY is in the configured list.
    const first = a.trend15m('RELIANCE', new Date(T0));
    release();
    await first;
    info.intraday15m.mockClear();
    const warmed = await a.prewarm(['NIFTY']);
    expect(warmed).toEqual(expect.arrayContaining(['NIFTY', 'RELIANCE']));
    // NIFTY's line + its near-month future (VWAP volume) + RELIANCE.
    const tokens = info.intraday15m.mock.calls.map((c) => c[1]);
    expect(tokens).toEqual(expect.arrayContaining([ref.token, NIFTY_FUT.token, '2885']));
    // A read right after the pre-warm is served from memory: no new fetch.
    info.intraday15m.mockClear();
    expect(await a.trend15m('NIFTY', new Date(T0))).toMatch(/15m close/);
    expect(info.intraday15m).not.toHaveBeenCalled();
  });

  it('a warm underlying whose venue is closed is not re-fetched by the pre-warm', async () => {
    const { a, info } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0), open: false });
    await a.prewarm(['NIFTY']);
    const n = info.intraday15m.mock.calls.length;
    await a.prewarm(['NIFTY']);
    expect(info.intraday15m.mock.calls.length).toBe(n);
  });

  it('the per-bar pass runs at bar close + 50 s (clear of the close + 20 s refreshers)', () => {
    expect(nextPrewarmAt(T0)).toBe(Date.parse('2026-11-27T05:45:50Z')); // 11:10 → 11:15:50 IST
    expect(nextPrewarmAt(Date.parse('2026-11-27T05:45:30Z'))).toBe(Date.parse('2026-11-27T05:45:50Z'));
    expect(nextPrewarmAt(Date.parse('2026-11-27T05:45:50Z'))).toBe(Date.parse('2026-11-27T06:00:50Z'));
  });

  it('the boot timer is armed for bar close + 50 s; each pass counts its historical calls', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const w = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0) });
    w.a.onApplicationBootstrap();
    const delays = spy.mock.calls.map((c) => c[1]);
    w.a.onModuleDestroy();
    spy.mockRestore();
    expect(delays).toContain(Date.parse('2026-11-27T05:45:50Z') - T0);
    const { a } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0) });
    await a.prewarm(['NIFTY']);
    expect(a.lastPrewarmHistoricalCalls).toBe(2); // NIFTY + its near-month future, both via the historical API
  });

  it('DESK_MANAGER=off starts no pre-warm timer', () => {
    const { a, info } = makeW4({ mode: 'off' });
    a.onApplicationBootstrap();
    a.onModuleDestroy();
    expect(info.intraday15m).not.toHaveBeenCalled();
  });
});

describe('W4 level book for every packet underlying', () => {
  const daily = () => [
    { day: '2026-11-24', high: 120, low: 90, close: 100 },
    { day: '2026-11-25', high: 130, low: 95, close: 110 },
    { day: '2026-11-26', high: 140, low: 96, close: 125 },
    { day: '2026-11-27', high: 999, low: 1, close: 500 }, // today's forming daily: never a "previous day"
  ];

  it('no in-memory book → built on demand from daily + 15m bars (PDH/PDL/prev close, OR from the first 15m bar)', async () => {
    const bars = () => sessionBars(['2026-11-26', '2026-11-27'], T0);
    const { a, info } = makeW4({ bars, daily });
    const lv = await a.levels('NIFTY', new Date(T0));
    const all = bars();
    const firstToday = all.find((b) => b.ts === IST('2026-11-27T09:15:00'))!;
    const firstPrev = all[0];
    expect(lv).toEqual(expect.arrayContaining([140, 96, 125, firstToday.high, firstToday.low, firstPrev.high, firstPrev.low]));
    expect(lv).not.toContain(999);
    // Daily statics are fetched once per session.
    await a.levels('NIFTY', new Date(T0 + MIN));
    expect(info.daily).toHaveBeenCalledTimes(1);
  });

  it('the built book is cached per (underlying, session, last closed bar), rebuilt when a bar closes', async () => {
    const { a, setNow } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], Date.parse('2026-11-27T06:00:00Z')), daily });
    await a.levels('NIFTY', new Date(T0));
    await a.levels('NIFTY', new Date(T0 + MIN));
    expect(a.builtBookHits).toBe(1);
    setNow(Date.parse('2026-11-27T05:46:00Z'));
    await a.levels('NIFTY', new Date(Date.parse('2026-11-27T05:46:00Z'))); // the 11:00–11:15 bar is now closed
    expect(a.builtBookHits).toBe(1);
  });

  it('SIGNAL_INFO_BARS missing → one warning, the setups market bars still serve', async () => {
    const market = {
      underlyingRef: jest.fn(async () => ref),
      ltps: jest.fn(async () => new Map<string, number>()),
      bars15m: jest.fn(async () => sessionBars(['2026-11-26', '2026-11-27'], T0)),
      master: jest.fn(async () => MASTER),
      isOpen: jest.fn(() => true),
      minutesToClose: jest.fn(() => 60),
    };
    const a = new DeskMarketAdapter(market as never, { getLevels: () => null } as never, {} as never, { mode: 'shadow' } as never, { get: () => undefined } as never);
    a.clock = () => T0;
    const warn = jest.spyOn((a as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    await a.trend15m('NIFTY', new Date(T0));
    await a.levels('NIFTY', new Date(T0));
    expect(warn.mock.calls.filter((c) => /SIGNAL_INFO_BARS/.test(String(c[0])))).toHaveLength(1);
    expect(market.bars15m).toHaveBeenCalled();
  });

  it('no daily answer → the previous session is taken from the 15m bars', async () => {
    const bars = () => sessionBars(['2026-11-26', '2026-11-27'], T0);
    const { a } = makeW4({ bars });
    const lv = await a.levels('NIFTY', new Date(T0));
    const prev = bars().filter((b) => b.ts < IST('2026-11-27T00:00:00'));
    expect(lv).toEqual(expect.arrayContaining([Math.max(...prev.map((b) => b.high)), Math.min(...prev.map((b) => b.low)), prev[prev.length - 1].close]));
  });

  it('an existing in-memory book is still used first', async () => {
    const book = { pdh: 555, pdl: 444, prevClose: 500, orh: null, orl: null, prevOrh: null, prevOrl: null, vwap: 0, spot: 0, roundNumbers: [], todayHigh: 0, todayLow: 0 };
    const { a, info } = makeW4({ bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0), daily, book });
    expect(await a.levels('NIFTY', new Date(T0))).toEqual(expect.arrayContaining([555, 444, 500]));
    expect(info.daily).not.toHaveBeenCalled();
  });
});

describe('W4 VWAP when the spot line has no volume', () => {
  it('an index takes its session VWAP weights from the near-month future, prices from the index bars', async () => {
    const vol = (ts: number) => (ts === IST('2026-11-27T09:15:00') ? 300 : ts === IST('2026-11-27T09:30:00') ? 100 : 0);
    const spot = sessionBars(['2026-11-26', '2026-11-27'], T0); // index: no volume
    const fut = sessionBars(['2026-11-26', '2026-11-27'], T0, vol, (i) => 200 + i); // future: volume, premium price
    const { a } = makeW4({ bars: (r) => (r.token === NIFTY_FUT.token ? fut : spot) });
    const day = await a.day('NIFTY', new Date(T0));
    const b1 = spot.find((b) => b.ts === IST('2026-11-27T09:15:00'))!;
    const b2 = spot.find((b) => b.ts === IST('2026-11-27T09:30:00'))!;
    const tp = (b: Bar15m) => (b.high + b.low + b.close) / 3;
    expect(day?.vwap).toBeCloseTo((tp(b1) * 300 + tp(b2) * 100) / 400, 6);
  });

  it('a line with its own volume uses it; no volume anywhere → vwap null', async () => {
    const own = sessionBars(['2026-11-26', '2026-11-27'], T0, () => 10);
    const r1 = makeW4({ refs: { RELIANCE: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' } }, bars: () => own });
    const today = own.filter((b) => b.ts >= IST('2026-11-27T00:00:00') && b.ts + 15 * MIN <= T0); // closed bars only
    const exp = today.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * 10, 0) / (10 * today.length);
    expect((await r1.a.day('RELIANCE', new Date(T0)))?.vwap).toBeCloseTo(exp, 6);
    const r2 = makeW4({ refs: { RELIANCE: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' } }, bars: () => sessionBars(['2026-11-26', '2026-11-27'], T0) });
    expect((await r2.a.day('RELIANCE', new Date(T0)))?.vwap).toBeNull();
  });
});
