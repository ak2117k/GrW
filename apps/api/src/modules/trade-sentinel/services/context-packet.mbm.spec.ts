import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { ContextPacketService, MBM_PACKET_LOG_EVERY_MS, type TickSnapshot } from './context-packet.service';
import { MBM_BLOCK_MAX_CHARS, istHhmm, marketBehaviourValue } from './market-behaviour-block';
import { parseMbmConfig } from '../../mbm/mbm.config';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';

// Fixtures and hashes copied from context-packet.news-events.spec.ts (recorded on main @ 7b976b3,
// never re-recorded) — the MBM flags off must reproduce them byte for byte.
const T0 = new Date('2026-10-16T05:00:00.000Z'); // 10:30 IST, a Friday — 300 min to the NSE close
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
const NIFTY = FIXTURES[1];
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x), 'utf8').digest('hex');

const OK: MbmBehaviour = {
  instrument: 'NIFTY', status: 'ok', asOf: '2026-10-16T04:15:00Z',
  horizons: {
    '60m': { p: 0.8571, regime: 'ACTIVE', q25Bp: 37.4, q50Bp: 51, q75Bp: 68.2 },
    '30m': { p: 0.61, regime: 'NORMAL', q25Bp: 20, q50Bp: 28, q75Bp: 41 },
  },
};

function make(env: Record<string, string> | undefined, answer: MbmBehaviour | (() => never) = OK) {
  const behaviour = jest.fn(async () => (typeof answer === 'function' ? answer() : answer));
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' }) } as never,
    undefined, undefined, undefined, undefined,
    env === undefined ? undefined : parseMbmConfig({ MBM_FEED_USER_ID: 'o', ...env }),
    { behaviour } as never,
  );
  return { svc, behaviour };
}
const hashes = async (svc: ContextPacketService) => {
  const out: Record<string, string> = {};
  for (const [name, e, t] of FIXTURES) out[name] = sha(await svc.build(e as never, t, null));
  return out;
};

let logSpy: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0);
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  logSpy.mockRestore();
});
const mbmLogs = () => logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[mbm-packet]'));

describe('MBM_PACKET off: the packet is main, byte for byte, and MBM is never asked', () => {
  it.each<[string, Record<string, string> | undefined]>([
    ['no MBM config wired', undefined],
    ['MBM_PACKET unset', { MBM_ENABLED: 'observe' }],
    ['MBM_PACKET=off', { MBM_ENABLED: 'observe', MBM_PACKET: 'off' }],
    ['MBM_ENABLED=off overrides MBM_PACKET=on', { MBM_PACKET: 'on' }],
    ['MBM_PACKET=typo', { MBM_ENABLED: 'on', MBM_PACKET: 'ture' }],
  ])('%s', async (_n, env) => {
    const { svc, behaviour } = make(env);
    expect(await hashes(svc)).toEqual(MAIN_PACKET_SHA256);
    expect(behaviour).not.toHaveBeenCalled();
    expect(mbmLogs()).toEqual([]);
  });
});

describe('MBM_PACKET=observe: packet unchanged, the would-be block is logged (throttled)', () => {
  const env = { MBM_ENABLED: 'observe', MBM_PACKET: 'observe' };

  it('every fixture hashes to main; only the NIFTY option asks MBM', async () => {
    const { svc, behaviour } = make(env);
    expect(await hashes(svc)).toEqual(MAIN_PACKET_SHA256);
    expect(behaviour).toHaveBeenCalledTimes(1);
    expect(behaviour).toHaveBeenCalledWith('NIFTY', T0.getTime());
  });

  it('logs once per position per 15 minutes', async () => {
    const { svc } = make(env);
    const [, e, t] = NIFTY;
    await svc.build(e as never, t, null);
    expect(mbmLogs()).toEqual([
      '[mbm-packet] would add marketBehaviour {"i":"NIFTY","h":"60m","regime":"ACTIVE","p":0.86,"rangeBp":[37,68],"asOf":"09:45"} — NIFTY28OCT2625000CE tracker t1',
    ]);
    jest.setSystemTime(T0.getTime() + MBM_PACKET_LOG_EVERY_MS - 1);
    await svc.build(e as never, t, null);
    await svc.build({ ...e, trackerId: 't2' } as never, t, null);
    expect(mbmLogs()).toHaveLength(2); // t1 throttled, t2 is a different position
    jest.setSystemTime(T0.getTime() + MBM_PACKET_LOG_EVERY_MS);
    await svc.build(e as never, t, null);
    expect(mbmLogs()).toHaveLength(3);
  });

  it.each<[string, MbmBehaviour]>([
    ['stale', { ...OK, status: 'stale' }],
    ['absent', { status: 'absent' }],
    ['non-finite p', { ...OK, horizons: { '60m': { ...OK.horizons!['60m'], p: NaN } } }],
  ])('%s answer: no log', async (_n, ans) => {
    const { svc } = make(env, ans);
    await svc.build(NIFTY[1] as never, NIFTY[2], null);
    expect(mbmLogs()).toEqual([]);
  });
});

describe('MBM_PACKET=on: the block is added for NIFTY-mapped positions only', () => {
  const env = { MBM_ENABLED: 'observe', MBM_PACKET: 'on' };

  it('adds marketBehaviour after events/news, before session; the rest is main byte for byte', async () => {
    const { svc } = make(env);
    const p = (await svc.build(NIFTY[1] as never, NIFTY[2], null)) as Record<string, unknown>;
    expect(p.marketBehaviour).toEqual({
      available: true,
      value: { i: 'NIFTY', h: '60m', regime: 'ACTIVE', p: 0.86, rangeBp: [37, 68], asOf: '09:45' },
      source: 'mbm',
      at: T0.toISOString(),
    });
    const keys = Object.keys(p);
    expect(keys.indexOf('marketBehaviour')).toBe(keys.indexOf('session') - 1);
    const { marketBehaviour: _mb, ...rest } = p;
    expect(sha(rest)).toBe(MAIN_PACKET_SHA256['NFO NIFTY option']);
    expect(mbmLogs()).toEqual([]);
  });

  it(`keeps the whole block within ${MBM_BLOCK_MAX_CHARS} characters, even with a long regime`, async () => {
    const { svc } = make(env, { ...OK, horizons: { '60m': { p: 0.123456, regime: 'X'.repeat(500), q25Bp: -12345.6, q50Bp: 1, q75Bp: 98765.4 } } });
    const p = await svc.build(NIFTY[1] as never, NIFTY[2], null);
    expect(JSON.stringify(p.marketBehaviour).length).toBeLessThanOrEqual(MBM_BLOCK_MAX_CHARS);
  });

  it('carries the relative reading and the range in points when the MBM service supplies them', async () => {
    const rel: MbmBehaviour = {
      ...OK,
      spot: 25_100,
      horizons: { '60m': { ...OK.horizons!['60m'], relRatio: 1.52, relLabel: 'BUSIER', refRangeBp: 33.6, rangePts: [94, 128, 171] } },
    };
    const { svc } = make(env, rel);
    const p = (await svc.build(NIFTY[1] as never, NIFTY[2], null)) as unknown as Record<string, { value: unknown }>;
    expect(p.marketBehaviour.value).toEqual({ i: 'NIFTY', h: '60m', regime: 'ACTIVE', p: 0.86, rangeBp: [37, 68], asOf: '09:45', rel: 'BUSIER', pts: [94, 128, 171] });
    // Worst case of every field still fits the budget.
    const worst: MbmBehaviour = {
      ...OK,
      spot: 99_999,
      horizons: { '60m': { p: 0.123456, regime: 'X'.repeat(500), q25Bp: -12345.6, q50Bp: 1, q75Bp: 98765.4, relLabel: 'MUCH_BUSIER', rangePts: [-99_999, 99_999, 99_999] } },
    };
    const w = await make(env, worst).svc.build(NIFTY[1] as never, NIFTY[2], null);
    expect(JSON.stringify(w.marketBehaviour).length).toBeLessThanOrEqual(MBM_BLOCK_MAX_CHARS);
  });

  it('computes points from bp × spot when the service sent no rangePts; an unknown label is dropped', async () => {
    const { svc } = make(env, { ...OK, spot: 25_000, horizons: { '60m': { ...OK.horizons!['60m'], relLabel: 'WILD' } } });
    const p = (await svc.build(NIFTY[1] as never, NIFTY[2], null)) as unknown as Record<string, { value: Record<string, unknown> }>;
    expect(p.marketBehaviour.value.pts).toEqual([94, 128, 171]);
    expect(p.marketBehaviour.value).not.toHaveProperty('rel');
  });

  it('unmapped fixtures are untouched and never ask MBM', async () => {
    const { svc, behaviour } = make(env);
    const h = await hashes(svc);
    for (const k of ['cash INFY', 'MCX CRUDEOILM future', 'unresolved underlying']) expect(h[k]).toBe(MAIN_PACKET_SHA256[k]);
    expect(behaviour).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MbmBehaviour | (() => never)]>([
    ['stale', { ...OK, status: 'stale' }],
    ['absent', { status: 'absent' }],
    ['missing horizon', { ...OK, horizons: { '30m': OK.horizons!['30m'] } }],
    ['a throwing client', () => { throw new Error('boom'); }],
  ])('%s ⇒ no block (packet is main)', async (_n, ans) => {
    const { svc } = make(env, ans);
    expect(sha(await svc.build(NIFTY[1] as never, NIFTY[2], null))).toBe(MAIN_PACKET_SHA256['NFO NIFTY option']);
  });

  it('picks the 30m horizon under an hour before the close', async () => {
    jest.setSystemTime(new Date('2026-10-16T09:30:00.000Z')); // 15:00 IST — 30 min left
    const { svc } = make(env);
    const p = await svc.build(NIFTY[1] as never, NIFTY[2], null);
    expect((p.marketBehaviour as unknown as { value: { h: string; regime: string } }).value).toMatchObject({ h: '30m', regime: 'NORMAL' });
  });

  it('after the close (no minutes left to pick a horizon from) ⇒ no block', async () => {
    jest.setSystemTime(new Date('2026-10-16T11:00:00.000Z')); // 16:30 IST
    const { svc } = make(env);
    const p = await svc.build(NIFTY[1] as never, NIFTY[2], null);
    expect('marketBehaviour' in p).toBe(false);
  });
});

describe('marketBehaviourValue / istHhmm', () => {
  it('null without minutes, and for a bad asOf the time is null rather than invented', () => {
    expect(marketBehaviourValue(OK, 'NIFTY', null)).toBeNull();
    expect(marketBehaviourValue({ ...OK, asOf: 'garbage' }, 'NIFTY', 90)?.asOf).toBeNull();
    expect(istHhmm('2026-10-16T03:45:00Z')).toBe('09:15');
  });
  it('null quantiles stay null', () => {
    const v = marketBehaviourValue({ ...OK, horizons: { '60m': { p: 0.5, regime: 'QUIET', q25Bp: null, q50Bp: null, q75Bp: 9 } } }, 'NIFTY', 61);
    expect(v?.rangeBp).toEqual([null, 9]);
  });
});
