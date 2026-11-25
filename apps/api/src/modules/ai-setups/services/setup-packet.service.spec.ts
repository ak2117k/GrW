import type { OptionsChainEntry, OptionsChainView } from '@td/shared/types';
import { parseAiSetupsConfig } from '../ai-setups.config';
import { LEVEL_KEYS, packetLevels } from '../domain/setup-checks';
import type { Claim } from '../../message-reader/domain/reading.types';
import { SetupPacketService, type SetupChainSource, type SetupPacketSources } from './setup-packet.service';

const NOW = new Date('2026-11-25T08:48:00Z'); // 14:18 IST
const DAY_MS = 86_400_000;
const IST = 330 * 60_000;
/** ms of an IST wall time. */
const ist = (ymd: string, hhmm: string) => Date.parse(`${ymd}T${hhmm}:00Z`) - IST;

const CLAIM: Claim = {
  text: 'Dabur breakout',
  subject: 'DABUR',
  bias: 'BULL',
  horizon: 'INTRADAY',
  claimType: 'DIRECTION',
  verdict: 'CONFIRMED',
  evidence: [{ fact: 'ltp above 60d high', value: '431', source: 'instruments.DABUR.quote' }],
};
const READING = { channelId: 'ch-1' };

const MASTER = [
  { exch_seg: 'NSE', symbol: 'DABUR-EQ', token: '772', name: 'DABUR' },
  { exch_seg: 'NFO', symbol: 'DABUR30DEC26430CE', token: '9001', name: 'DABUR', instrumenttype: 'OPTSTK', expiry: '30DEC2026', strike: '43000.000000', lotsize: '1250' },
];

function daburDaily() {
  const out: Array<{ day: string; high: number; low: number; close: number; volume: number }> = [];
  for (let i = 0; i < 65; i++) {
    const day = new Date(Date.UTC(2026, 7, 1) + i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, high: 390, low: 370, close: 380, volume: 2_000_000 });
  }
  out[54].high = 403;
  out[64] = { ...out[64], high: 401, low: 396, close: 400 };
  out.push({ day: '2026-11-25', high: 433, low: 404, close: 431, volume: 14_500_000 });
  return out;
}

/** Previous session (24 Nov) 09:15–15:15, today 09:15–14:15 (14:15 still forming), a pre-open bar, and an old bar. */
function daburBars() {
  const out: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  const add = (ymd: string, hhmm: string, o: number, h: number, l: number, c: number, v = 100_000) => out.push({ ts: ist(ymd, hhmm), open: o, high: h, low: l, close: c, volume: v });
  add('2026-11-21', '10:00', 395, 396, 394, 395); // three sessions back: dropped
  for (let k = 0; k < 25; k++) {
    const m = 555 + k * 15;
    add('2026-11-24', `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 398, 400, 396, 399);
  }
  add('2026-11-25', '09:00', 405, 406, 404, 405); // pre-open: dropped
  for (let k = 0; k < 21; k++) {
    const m = 555 + k * 15;
    const base = 404 + k;
    add('2026-11-25', `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, base, base + 2, base - 1, base + 1);
  }
  // A clear 15m swing high at 13:00 (bar 15) and a swing low after it.
  const b13 = out.find((b) => b.ts === ist('2026-11-25', '13:00'))!;
  b13.high = 428.5;
  const b1315 = out.find((b) => b.ts === ist('2026-11-25', '13:15'))!;
  b1315.low = 417.5;
  return out;
}

function leg(ltp: number, over: Partial<{ delta: number; bid: number; ask: number; oi: number; lotSize: number }> = {}) {
  return {
    ltp,
    oi: over.oi ?? 120_000,
    oiChange: 0,
    volume: 50_000,
    iv: 30,
    delta: over.delta ?? 0.5,
    gamma: 0,
    theta: 0,
    vega: 0,
    bidPrice: over.bid ?? ltp - 0.1,
    askPrice: over.ask ?? ltp + 0.1,
    ...(over.lotSize ? { lotSize: over.lotSize } : {}),
  };
}

function chainView(over: Partial<OptionsChainView> = {}, lot?: number): OptionsChainView {
  const chain: OptionsChainEntry[] = [];
  for (let s = 380; s <= 480; s += 5) {
    chain.push({ strikePrice: s, expiryDate: '2026-12-30', ceData: leg(Math.max(1, 440 - s), { lotSize: lot, delta: s === 455 ? 0 : 0.5 }), peData: leg(Math.max(1, s - 420), { lotSize: lot, delta: -0.5 }) });
  }
  return { chain, spotPrice: 431, at: NOW.toISOString(), source: 'hub', status: 'fresh', greeks: 'broker', ...over };
}

function make(
  over: {
    resolveQuotes?: jest.Mock;
    daily?: jest.Mock;
    intraday15m?: jest.Mock;
    chain?: Partial<SetupChainSource>;
    news?: jest.Mock;
    channelRecord?: jest.Mock;
    deskToday?: jest.Mock;
    owner?: string | null;
    packetMs?: number;
    master?: unknown[];
  } = {},
) {
  const quotes = {
    resolveQuotes:
      over.resolveQuotes ??
      jest.fn(async (_u: string, refs: Array<{ token: string }>) => new Map(refs.map((r) => [r.token, { token: r.token, ltp: 431, open: 404, high: 433, low: 403.5, close: 400, volume: 14_500_000, timestamp: new Date(NOW.getTime() - 5_000) }]))),
  };
  const bars = { daily: over.daily ?? jest.fn().mockResolvedValue(daburDaily()), intraday15m: over.intraday15m ?? jest.fn().mockResolvedValue(daburBars()) };
  const master = { rows: jest.fn().mockResolvedValue(over.master ?? MASTER) };
  const vocab = { get: jest.fn().mockResolvedValue({ names: new Map(), classOf: new Map([['DABUR', 'STOCK']]) }) };
  const chain: SetupChainSource = {
    getExpiries: jest.fn().mockResolvedValue(['2026-11-25', '2027-01-27', '2026-12-30']),
    getChainView: jest.fn().mockResolvedValue(chainView()),
    ...over.chain,
  };
  const news = {
    getNewsForSymbol:
      over.news ??
      jest.fn().mockResolvedValue([
        { title: 'Dabur jumps on rural demand', source: 'mc', sentiment: 'positive', publishedAt: new Date(NOW.getTime() - 20 * 60_000) },
        { title: 'Dabur Q2 old', source: 'et', sentiment: 'neutral', publishedAt: new Date(NOW.getTime() - 3 * 3_600_000) },
      ]),
  };
  const sources: SetupPacketSources = {
    channelRecord: over.channelRecord ?? jest.fn().mockResolvedValue({ calls: 12, winRate: 0.42 }),
    deskToday: over.deskToday ?? jest.fn().mockResolvedValue({ setupsToday: 1, openTrades: [] }),
  };
  const cfg = { ...parseAiSetupsConfig({}), packetMs: over.packetMs ?? 2_000 };
  const svc = new SetupPacketService(quotes, sources, cfg, { ownerUserId: over.owner === undefined ? 'owner-1' : over.owner }, bars as never, master, vocab as never, chain, news);
  return { svc, quotes, bars, chain, news, sources };
}

const build = (svc: SetupPacketService, now = NOW) => svc.build({ underlying: 'dabur', claim: CLAIM, reading: READING, now });
const val = <T = Record<string, unknown>>(b: { status: string }) => {
  expect(b.status).toBe('present');
  return (b as unknown as { value: T }).value;
};
const why = (b: { status: string }) => {
  expect(b.status).toBe('unavailable');
  return (b as unknown as { reason: string }).reason;
};

describe('SetupPacketService.build', () => {
  it('DABUR: every block present with the numbers the setup needs', async () => {
    const { svc, bars, chain, sources } = make();
    const { packet, ms } = await build(svc);
    expect(typeof ms).toBe('number');
    expect(packet.underlying).toBe('DABUR');
    expect(packet.optionExchange).toBe('NFO');
    // Only the claim's labels: its text, read-time evidence and the reading summary are not in the packet (not present state).
    expect(packet.claim).toEqual({ subject: 'DABUR', bias: 'BULL', horizon: 'INTRADAY', claimType: 'DIRECTION', verdict: 'CONFIRMED' });
    expect(JSON.stringify(packet)).not.toContain('Dabur breakout');
    expect(JSON.stringify(packet)).not.toContain('ltp above 60d high');
    expect(packet.rules).toMatchObject({ minRewardRisk: 1.2, antiChaseAtr15m: 1.5, maxSpreadPct: 2, minOi: 500, maxSetupsPerDay: 3 });

    expect(val(packet.quote)).toMatchObject({ ltp: 431, dayHigh: 433, dayLow: 403.5, open: 404, volume: 14_500_000 });

    const d = val(packet.daily60);
    expect(d).toMatchObject({ sessions: 60, prevHigh: 401, prevLow: 396, prevClose: 400, high60d: 403, low60d: 370, avgVolume20d: 2_000_000 });
    expect(d.atr14).toBeGreaterThan(0);
    expect((d.recent as unknown[]).length).toBe(10);

    const b = val<{ sessions: string[]; atr15m: number; vwap: number; bars: Array<Record<string, unknown>> }>(packet.bars15m);
    expect(b.sessions).toEqual(['2026-11-24', '2026-11-25']);
    // 25 bars yesterday + today's closed 09:15..14:00 (20); the forming 14:15 bar, the pre-open and the old bar are out.
    expect(b.bars).toHaveLength(45);
    expect(b.bars[0]).toEqual({ ts: '2026-11-24 09:15', open: 398, high: 400, low: 396, close: 399, volume: 100_000 });
    expect(b.bars[b.bars.length - 1].ts).toBe('2026-11-25 14:00');
    expect(b.atr15m).toBeGreaterThan(0);
    expect(b.vwap).toBeGreaterThan(404);
    // Never 1m: only 15m bars were asked for.
    expect(bars.intraday15m).toHaveBeenCalledWith('NSE', '772', expect.any(Date), NOW);

    const c = val<{ expiry: string; lotSize: number; spot: number; rows: Array<{ strike: number; ce: Record<string, unknown> | null }> }>(packet.chain);
    expect(chain.getChainView).toHaveBeenCalledWith('DABUR', '2026-12-30'); // the expiry-day contract (25 Nov) is skipped
    expect(c.expiry).toBe('2026-12-30');
    expect(c.lotSize).toBe(1250); // from the instrument master (no lot on this chain)
    expect(c.rows.map((r) => r.strike)).toEqual([405, 410, 415, 420, 425, 430, 435, 440, 445, 450, 455]);
    const atm = c.rows.find((r) => r.strike === 430)!.ce!;
    expect(atm).toMatchObject({ ltp: 10, oi: 120_000, volume: 50_000, bid: 9.9, ask: 10.1, spreadPct: 2, delta: 0.5 });
    expect(c.rows.find((r) => r.strike === 455)!.ce!.delta).toBeNull(); // a 0 Greek is "unknown", not 0

    const n = val<{ count: number; headlines: Array<{ title: string }> }>(packet.news60m);
    expect(n.count).toBe(1);
    expect(n.headlines[0].title).toBe('Dabur jumps on rural demand');

    expect(val(packet.channelRecord)).toEqual({ calls: 12, winRate: 0.42 });
    expect(sources.channelRecord).toHaveBeenCalledWith('ch-1');
    expect(val(packet.deskToday)).toMatchObject({ setupsToday: 1, openTrades: [], maxSetupsPerDay: 3, ceilingRupees: 2000 });
    expect(sources.deskToday).toHaveBeenCalledWith('2026-11-25', 'DABUR');
    expect(val(packet.timeToClose)).toEqual({ nowIst: '14:18', lastValidIst: '15:15', minutesLeft: 57 });
  });

  it('the anti-chase levels come from the underlying blocks only: 15m swings, VWAP, day / prior / 60d — never option-chain numbers', async () => {
    const { svc } = make();
    const { packet } = await build(svc);
    const levels = packetLevels(packet, 431);
    for (const l of [428.5, 417.5, 401, 396, 400, 403, 370, 433, 403.5]) expect(levels.has(l)).toBe(true);
    expect(levels.has((val(packet.bars15m) as { vwap: number }).vwap)).toBe(true);
    // Chain rows never carry an underlying-level field name.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k.toLowerCase()), walk(x));
    };
    walk(packet.chain);
    for (const k of LEVEL_KEYS) expect(keys.has(k)).toBe(false);
    // Strikes are not levels (430, 435 are only in the chain).
    expect(levels.has(435)).toBe(false);
  });

  it('a hub chain lot size is used when the chain carries one', async () => {
    const { svc } = make({ chain: { getChainView: jest.fn().mockResolvedValue(chainView({}, 625)) } });
    const { packet } = await build(svc);
    expect(val(packet.chain).lotSize).toBe(625);
  });

  it('blocks are unavailable with their reasons, never a throw', async () => {
    const { svc } = make({
      chain: { getChainView: jest.fn().mockResolvedValue(chainView({ status: 'unavailable', chain: [], spotPrice: null, unavailable: 'throttled' })) },
      news: jest.fn().mockRejectedValue(new Error('db down')),
      channelRecord: jest.fn().mockResolvedValue(null),
      deskToday: jest.fn().mockRejectedValue(new Error('trades read failed')),
    });
    const { packet } = await build(svc);
    expect(why(packet.chain)).toMatch(/chain unavailable \(throttled\)/);
    expect(why(packet.news60m)).toMatch(/db down/);
    expect(why(packet.channelRecord)).toMatch(/no record for this channel/);
    expect(why(packet.deskToday)).toMatch(/trades read failed/);
    expect(packet.quote.status).toBe('present');
  });

  it('a stale chain is unavailable (its bid / ask are not current)', async () => {
    const { svc } = make({ chain: { getChainView: jest.fn().mockResolvedValue(chainView({ status: 'stale' })) } });
    expect(why((await build(svc)).packet.chain)).toMatch(/chain stale/);
  });

  it('no expiry after today → chain unavailable', async () => {
    const { svc } = make({ chain: { getExpiries: jest.fn().mockResolvedValue(['2026-11-25']) } });
    expect(why((await build(svc)).packet.chain)).toMatch(/no listed DABUR option expiry after today/);
  });

  it('a stale quote makes quote unavailable and skips the bar reads (no work on the owner\'s historical lane)', async () => {
    const { svc, bars } = make({
      resolveQuotes: jest.fn(async (_u: string, refs: Array<{ token: string }>) => new Map(refs.map((r) => [r.token, { token: r.token, ltp: 431, open: 1, high: 1, low: 1, close: 1, volume: 1, timestamp: new Date(NOW.getTime() - 30 * 60_000) }]))),
    });
    const { packet } = await build(svc);
    expect(why(packet.quote)).toMatch(/stale quote/);
    expect(why(packet.daily60)).toMatch(/skipped: no fresh live quote/);
    expect(why(packet.bars15m)).toMatch(/skipped: no fresh live quote/);
    expect(bars.daily).not.toHaveBeenCalled();
    expect(bars.intraday15m).not.toHaveBeenCalled();
  });

  it('no owner session → every broker block unavailable, no broker call', async () => {
    const { svc, quotes, chain } = make({ owner: null });
    const { packet } = await build(svc);
    for (const b of [packet.quote, packet.daily60, packet.bars15m, packet.chain]) expect(why(b)).toMatch(/no owner user id/);
    expect(quotes.resolveQuotes).not.toHaveBeenCalled();
    expect(chain.getExpiries).not.toHaveBeenCalled();
    expect(packet.news60m.status).toBe('present');
  });

  it('unknown underlying → quote / bars unavailable with the reason', async () => {
    const { svc } = make({ master: [] });
    const { packet } = await build(svc);
    expect(why(packet.quote)).toMatch(/no instrument for DABUR/);
    expect(why(packet.bars15m)).toMatch(/no instrument for DABUR/);
  });

  it('a hung chain is unavailable within the packet time box; the other blocks are kept', async () => {
    const { svc } = make({ packetMs: 300, chain: { getChainView: jest.fn(() => new Promise<OptionsChainView>(() => undefined)) } });
    const t0 = Date.now();
    const { packet } = await build(svc);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(why(packet.chain)).toMatch(/timed out/);
    expect(packet.quote.status).toBe('present');
    expect(packet.bars15m.status).toBe('present');
  });

  it('daily bars are fetched once per instrument per IST day', async () => {
    const { svc, bars } = make();
    await build(svc);
    await build(svc);
    expect(bars.daily).toHaveBeenCalledTimes(1);
  });

  it('at most 2 packet builds reach the broker at once; a third without a permit by the deadline makes no broker call', async () => {
    // Fake clock: the three builds start at the same instant, so they share one deadline.
    jest.useFakeTimers({ now: Date.now() });
    try {
      const hang = jest.fn(() => new Promise<Map<string, unknown>>(() => undefined));
      const { svc } = make({ packetMs: 300, resolveQuotes: hang });
      const all = Promise.all([build(svc), build(svc), build(svc)]);
      await jest.advanceTimersByTimeAsync(301);
      const out = await all;
      expect(hang).toHaveBeenCalledTimes(2);
      const limited = out.filter((o) => o.packet.quote.status === 'unavailable' && /setup packet limit/.test((o.packet.quote as { reason: string }).reason));
      expect(limited).toHaveLength(1);
      expect(why(limited[0].packet.chain)).toMatch(/setup packet limit/);
      // The permits come back at the deadline: the next build reaches the broker again.
      const next = build(svc);
      await jest.advanceTimersByTimeAsync(301);
      await next;
      expect(hang).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('MCX: time to close runs to 23:00 and the ceiling is the MCX class (default ₹2,000)', async () => {
    const { svc } = make();
    const { packet } = await svc.build({ underlying: 'CRUDEOIL', claim: { ...CLAIM, subject: 'CRUDEOIL' }, reading: READING, now: new Date('2026-11-25T14:30:00Z') }); // 20:00 IST
    expect(packet.optionExchange).toBe('MCX');
    expect(val(packet.timeToClose)).toEqual({ nowIst: '20:00', lastValidIst: '23:00', minutesLeft: 180 });
    expect(val(packet.deskToday).ceilingRupees).toBe(2000);
  });
});
