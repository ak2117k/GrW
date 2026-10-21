import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { ContextPacketService, withLessons, absent, type TickSnapshot } from './context-packet.service';
import type { InjectedLesson, InjectionScope, LessonsReader } from '../../self-review/lessons/types';

// Fixtures and hashes copied from context-packet.mbm.spec.ts (recorded on main @ 7b976b3, never
// re-recorded) — with no lessons to inject the packet must reproduce them byte for byte.
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
const INFY = entry('NSE', 'INFY');
const MAIN_INFY_SHA256 = 'f3e1f449acc86e931d3a3a7214fb7bdb2c1d77f5f0a563d3099ffef9bca87853';
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x), 'utf8').digest('hex');

const LESSON: InjectedLesson = { key: 'theta-exit-on-supported-put', text: 'Do not exit a supported put on theta alone.', right: 3, wrong: 1 };

function make(reader?: LessonsReader, prior: unknown[] = []) {
  return new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue(prior) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' }) } as never,
    undefined, undefined, undefined, undefined, undefined, undefined,
    reader,
  );
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('sentinel packet memory.lessons', () => {
  it('no reader wired, or a reader with nothing to inject: the packet is main, byte for byte', async () => {
    expect(sha(await make().build(INFY as never, baseTick, null))).toBe(MAIN_INFY_SHA256);
    const inject = jest.fn(() => []);
    expect(sha(await make({ inject }).build(INFY as never, baseTick, null))).toBe(MAIN_INFY_SHA256);
    expect(inject).toHaveBeenCalledWith('SENTINEL_LIVE');
  });

  it('attaches lessons to memory and changes nothing else', async () => {
    const base = await make().build(INFY as never, baseTick, null);
    const withL = await make({ inject: () => [LESSON] }).build(INFY as never, baseTick, null);
    expect(withL.memory).toEqual({ ...base.memory, lessons: [LESSON] });
    const { memory: _a, ...restBase } = base;
    const { memory: _b, ...restWith } = withL;
    expect(restWith).toEqual(restBase);
  });

  it('keeps prior verdicts in memory.value alongside the lessons', async () => {
    const prior = [{ verdict: 'HOLD', reason: 'thesis intact', createdAt: new Date('2026-10-16T04:30:00Z') }];
    const p = await make({ inject: () => [LESSON] }, prior).build(INFY as never, baseTick, null);
    expect(p.memory).toMatchObject({ available: true, value: [{ verdict: 'HOLD' }], lessons: [LESSON] });
  });

  it('asks for the overnight scope when the packet is built for an overnight window', async () => {
    const seen: InjectionScope[] = [];
    const svc = make({ inject: (s) => (seen.push(s), []) });
    for (const name of ['OVERNIGHT_REVIEW', 'PRE_OPEN_REVIEW', 'PRE_OPEN_CHECK', 'level-break']) {
      await svc.build(INFY as never, baseTick, null, [{ name, detail: 'x' }] as never);
    }
    expect(seen).toEqual(['SENTINEL_OVERNIGHT', 'SENTINEL_OVERNIGHT', 'SENTINEL_OVERNIGHT', 'SENTINEL_LIVE']);
  });

  it('a reader that throws costs the lessons, never the packet', async () => {
    const p = await make({ inject: () => { throw new Error('boom'); } }).build(INFY as never, baseTick, null);
    expect(sha(p)).toBe(MAIN_INFY_SHA256);
  });

  it('withLessons adds the key only for a non-empty list', () => {
    const m = absent('first look');
    expect(withLessons(m, [])).toBe(m);
    expect(withLessons(m, [LESSON])).toEqual({ available: false, reason: 'first look', lessons: [LESSON] });
  });
});
