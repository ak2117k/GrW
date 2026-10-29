import { createHash } from 'crypto';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';
import { CASH_OI_WALLS_REASON, PRICE_BAND_UNSEEN } from './equity-blocks';

// Fixtures and hashes as in context-packet.stock-move.spec.ts (recorded on main @ 7b976b3): every
// F&O packet must reproduce them byte for byte with the equity block ON, and every packet with it OFF.
const T0 = new Date('2026-10-16T05:00:00.000Z'); // Friday 10:30 IST
const entry = (exchange: string, symbol: string) => ({
  exchange, userId: 'u1', trackerId: 't1', symbol, kind: 'POSITION' as const, ownership: 'SENTINEL' as const, watched: true, reason: '',
});
const baseTick: TickSnapshot = {
  segment: 'EQ_INTRADAY', side: 'LONG', structureSymbol: 'INFY', entryPrice: 100, qty: 100, ltp: 120, underlyingLtp: 120,
  underlyingLtpAt: null, underlyingLtpSource: 'market-data (underlying spot — live feed tick)', underlyingLtpReason: null,
  nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null, structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 125, holdingLow: 98, entryTime: new Date('2026-10-16T04:00:00Z'), expiry: null, volumeRatio: null, freshNewsCount: 1,
  factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
} as TickSnapshot;
const FIXTURES: Array<[string, ReturnType<typeof entry>, TickSnapshot]> = [
  ['cash INFY', entry('NSE', 'INFY'), baseTick],
  ['NFO NIFTY option', entry('NFO', 'NIFTY28OCT2625000CE'), { ...baseTick, segment: 'OPT', structureSymbol: 'NIFTY', expiry: '2026-10-28', underlyingLtp: 25100 } as TickSnapshot],
  ['MCX CRUDEOILM future', entry('MCX', 'CRUDEOILM19NOV26FUT'), { ...baseTick, segment: 'FUT', structureSymbol: 'CRUDEOILM', expiry: '2026-11-19', ltp: 5900, underlyingLtp: 5900 } as TickSnapshot],
  ['unresolved underlying', entry('NFO', 'XYZ28OCT26100CE'), { ...baseTick, segment: 'OPT', structureSymbol: null } as TickSnapshot],
];
const MAIN_PACKET_SHA256: Record<string, string> = {
  'cash INFY': 'f3e1f449acc86e931d3a3a7214fb7bdb2c1d77f5f0a563d3099ffef9bca87853',
  'NFO NIFTY option': '3872b33cebb0355efe92000997bd71c88db0a3750b75d643814321f7a0063e12',
  'MCX CRUDEOILM future': 'b50f341524948d72b1bd9729e3216977af5f9c93381589cc8d7f5e4d747a1719',
  'unresolved underlying': '6baf97b8b7cd611e7e4a519ba4aa7d9d8bcdf7dc9924586fb6549e3d98e1bd83',
};
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x), 'utf8').digest('hex');

function make(env: Record<string, string> | null, levels: unknown = null) {
  return new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(levels) } as never,
    { recentFor: jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' }) } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    env === null ? undefined : ({ get: (k: string) => env[k] } as never),
  );
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0));
afterEach(() => jest.useRealTimers());

describe('sentinel packet — equity block (SENTINEL_EQUITY_BLOCK)', () => {
  it.each<[string, Record<string, string> | null]>([
    ['no ConfigService', null],
    ['SENTINEL_EQUITY_BLOCK=false', { SENTINEL_EQUITY_BLOCK: 'false' }],
  ])('%s: every packet is main byte for byte', async (_n, env) => {
    const svc = make(env);
    for (const [name, e, t] of FIXTURES) expect(sha(await svc.build(e as never, t, null))).toBe(MAIN_PACKET_SHA256[name]);
  });

  it('on (the default with config): F&O packets are main byte for byte; only the cash one changes', async () => {
    const svc = make({});
    for (const [name, e, t] of FIXTURES.slice(1)) {
      const p = await svc.build(e as never, t, null);
      expect('equity' in p).toBe(false);
      expect(sha(p)).toBe(MAIN_PACKET_SHA256[name]);
    }
  });

  it('on, cash: the equity block sits before session, the OI reason is the cash one, and nothing else moves', async () => {
    const [, e, t] = FIXTURES[0];
    const p = await make({}).build(e as never, t, null);
    expect(p.equity).toBeDefined();
    const keys = Object.keys(p);
    expect(keys.indexOf('equity')).toBe(keys.indexOf('session') - 1);
    expect(p.flow.oiWalls).toEqual({ available: false, reason: CASH_OI_WALLS_REASON });
    // Undo the two cash-only edits: the remainder is main's cash packet exactly.
    const { equity: _e, ...rest } = p;
    const restored = { ...rest, flow: { ...rest.flow, oiWalls: { available: false, reason: 'no options chain for this symbol, so no OI walls' } } };
    expect(sha(restored)).toBe(MAIN_PACKET_SHA256['cash INFY']);
    // No level book in this fixture: every book-based factor says so instead of reading 0.
    expect(p.equity!.vwap).toEqual({ available: false, reason: expect.stringMatching(/no level book/) });
    expect(p.equity!.dayRange.available).toBe(false);
    expect(p.equity!.relativeStrength).toEqual({ available: false, reason: expect.stringMatching(/NIFTY was not read/) });
    expect(p.equity!.priceBand).toEqual({ available: false, reason: PRICE_BAND_UNSEEN });
    expect(p.equity!.eventRisk).toEqual({ available: false, reason: expect.stringMatching(/UNSEEN, not none/) });
    // Friday 10:30 IST ⇒ 285 minutes to the 15:15 MIS square-off.
    expect(p.equity!.squareOff).toMatchObject({ available: true, value: 285 });
  });

  it('on, cash with a level book and tick inputs: the factors are read in the stock own units', async () => {
    const levels = {
      value: { pdh: 118, pdl: 110, orh: 116, orl: 112, prevOrh: null, prevOrl: null, vwap: 118, todayHigh: 125, todayLow: 112, atr14: 10, interval: '15m' },
      source: 'signal-generator.analyze (15m level book)',
      at: '2026-10-16T04:59:30.000Z',
    };
    const tick = {
      ...baseTick,
      noise: { contract: { n: 0.5, method: 'atr14-1m', bars: 30, at: '2026-10-16T04:59:00.000Z' }, underlying1m: null, reason: null },
      equityInputs: {
        day: { ok: true, open: 112, prevClose: 110, at: '2026-10-16T04:59:59.000Z', source: 'market-hub day bar (broker-reported)' },
        nifty: { ok: true, ltp: 24_240, prevClose: 24_000, at: '2026-10-16T04:59:59.000Z', source: 'live level book (NIFTY live feed tick)' },
        niftyAtEntry: { ok: true, close: 24_000, at: '2026-10-16T04:00:00.000Z', source: 'hub candles_1m NIFTY bar at entry' },
      },
    } as TickSnapshot;
    const p = await make({ SENTINEL_EQ_SQUAREOFF_IST: '15:20' }, levels).build(entry('NSE', 'INFY') as never, tick, null);
    expect(p.equity!.squareOff).toMatchObject({ value: 290 });
    expect(p.equity!.vwap).toMatchObject({ available: true, value: { vwap: 118, gapRupees: 2, gapN: 4 } });
    expect(p.equity!.dayRange).toMatchObject({ available: true, value: { rangeUsedAtr: 1.3, regime: 'EXPANDED', gapAtr: 0.2, fromEntryAtr: 2, pullbackFromPeakN: 10 } });
    expect(p.equity!.relativeStrength).toMatchObject({ available: true, value: { sinceEntry: { stockPct: 20, niftyPct: 1, label: 'STOCK-SPECIFIC' } } });
    // Survives the jsonb write.
    expect(JSON.parse(JSON.stringify(p.equity))).toEqual(p.equity);
  });
});
