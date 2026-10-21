import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';
import { stockMoveValue } from './market-behaviour-block';
import { parseMbmConfig } from '../../mbm/mbm.config';
import type { StockMoveReading } from '../../stock-move/stock-move.logic';

// Fixtures and hashes as in context-packet.mbm.spec.ts (recorded on main @ 7b976b3): with the
// stockMove block absent the packet must reproduce them byte for byte.
const T0 = new Date('2026-10-16T05:00:00.000Z');
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

const READING = (symbol: string): StockMoveReading => ({
  symbol, asOf: '2026-10-15', horizonDays: 5, pBig: 0.7149, rankPct: 0.97, bucket: 'TOP20',
  resultsDate: '2026-10-17', resultsInWindow: true, modelId: 'm1',
});

function make(env: Record<string, string> | undefined, known: readonly string[] = ['INFY']) {
  const get = jest.fn((s: string) => (known.includes(s) ? READING(s) : null));
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' }) } as never,
    undefined, undefined, undefined, undefined,
    env === undefined ? undefined : parseMbmConfig({ MBM_FEED_USER_ID: 'o', ...env }),
    // MBM is never usable here, so the only possible addition is stockMove.
    { behaviour: jest.fn(async () => ({ status: 'absent' })) } as never,
    undefined,
    { get },
  );
  return { svc, get };
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
const logs = () => logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[mbm-packet] would add stockMove'));

describe('sentinel packet — stockMove block', () => {
  it.each<[string, Record<string, string> | undefined]>([
    ['no MBM config', undefined],
    ['MBM_PACKET=off', { MBM_ENABLED: 'observe', MBM_PACKET: 'off' }],
  ])('%s: packet is main byte for byte, the book is not read', async (_n, env) => {
    const { svc, get } = make(env);
    expect(await hashes(svc)).toEqual(MAIN_PACKET_SHA256);
    expect(get).not.toHaveBeenCalled();
  });

  it('MBM_PACKET=observe: packet unchanged; the would-be block is logged for the stock position', async () => {
    const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'observe' });
    expect(await hashes(svc)).toEqual(MAIN_PACKET_SHA256);
    expect(logs()).toEqual([
      '[mbm-packet] would add stockMove {"s":"INFY","h":"5d","p":0.71,"b":"TOP20","results":"2026-10-17","inWindow":true,"asOf":"2026-10-15"} — INFY tracker t1',
    ]);
  });

  it('MBM_PACKET=on: a stock position gets the block before session; index / MCX never; the rest is main', async () => {
    const { svc, get } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'on' });
    const [, e, t] = FIXTURES[0];
    const p = await svc.build(e as never, t, null);
    expect(p.stockMove).toEqual({
      available: true, source: 'stock-move', at: T0.toISOString(),
      value: { s: 'INFY', h: '5d', p: 0.71, b: 'TOP20', results: '2026-10-17', inWindow: true, asOf: '2026-10-15' },
    });
    const keys = Object.keys(p);
    expect(keys.indexOf('stockMove')).toBe(keys.indexOf('session') - 1);
    const { stockMove: _s, ...rest } = p;
    expect(sha(rest)).toBe(MAIN_PACKET_SHA256['cash INFY']);
    const opt = await svc.build(entry('NFO', 'INFY28OCT261500CE') as never, { ...baseTick, segment: 'OPT', expiry: '2026-10-28' } as TickSnapshot, null);
    expect(get).toHaveBeenCalledWith('INFY');
    expect((opt.stockMove as unknown as { value: { s: string } }).value.s).toBe('INFY');
    for (const [name, en, tk] of FIXTURES.slice(1, 3)) {
      expect('stockMove' in (await svc.build(en as never, tk, null))).toBe(false);
      expect(get).not.toHaveBeenCalledWith(name.includes('NIFTY') ? 'NIFTY' : 'CRUDEOILM');
    }
  });

  it('MBM_PACKET=on: an unscored stock (empty table) adds nothing', async () => {
    const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'on' }, []);
    expect(await hashes(svc)).toEqual(MAIN_PACKET_SHA256);
  });

  it('stockMoveValue: null for no / non-finite reading, bucket bounded', () => {
    expect(stockMoveValue(null)).toBeNull();
    expect(stockMoveValue({ ...READING('A'), pBig: NaN })).toBeNull();
    expect(stockMoveValue({ ...READING('A'), bucket: 'X'.repeat(40) })?.b).toHaveLength(10);
  });
});
