import { Logger } from '@nestjs/common';
import { ContextPacketService, MBM_PACKET_TUNABLE, sinceLastVerdictBlock, type TickSnapshot } from './context-packet.service';
import { parseMbmConfig } from '../../mbm/mbm.config';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';
import type { TuningReader } from '../../self-review/tuning/tunables';

const T0 = new Date('2026-10-16T05:00:00.000Z'); // 10:30 IST, a Friday
const NIFTY_ENTRY = {
  exchange: 'NFO', userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2625000CE', kind: 'POSITION' as const,
  ownership: 'SENTINEL' as const, watched: true, reason: '',
};
const TICK = {
  segment: 'OPT', side: 'LONG', structureSymbol: 'NIFTY', entryPrice: 100, qty: 75, ltp: 120, underlyingLtp: 25100,
  underlyingLtpAt: null, underlyingLtpSource: 'market-data (underlying spot — live feed tick)', underlyingLtpReason: null,
  nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null, structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 125, holdingLow: 98, entryTime: new Date('2026-10-16T04:00:00Z'), expiry: '2026-10-28', volumeRatio: null, freshNewsCount: 1,
  factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
} as unknown as TickSnapshot;

const OK: MbmBehaviour = {
  instrument: 'NIFTY', status: 'ok', asOf: '2026-10-16T04:15:00Z',
  horizons: {
    '60m': { p: 0.8571, regime: 'ACTIVE', q25Bp: 37.4, q50Bp: 51, q75Bp: 68.2 },
    '30m': { p: 0.61, regime: 'NORMAL', q25Bp: 20, q50Bp: 28, q75Bp: 41 },
  },
};

function make(env: Record<string, string>, tuning?: TuningReader) {
  const behaviour = jest.fn(async () => OK);
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
    { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn().mockResolvedValue(null) } as never,
    undefined, undefined, undefined, undefined,
    parseMbmConfig({ MBM_FEED_USER_ID: 'o', ...env }),
    { behaviour } as never,
    undefined,
    undefined,
    tuning,
  );
  return { svc, behaviour };
}
const tunable = (value: unknown): TuningReader & { get: jest.Mock } =>
  ({ get: jest.fn((target: string, fallback: unknown) => (target === MBM_PACKET_TUNABLE ? value : fallback)) }) as never;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('MBM packet gating: the judge sees MBM only when MBM_PACKET=on OR the self-review tunable mbm.packet is true', () => {
  it('MBM_PACKET=observe and the tunable false/absent: no block (observe only logs)', async () => {
    for (const tuning of [undefined, tunable(false)]) {
      const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'observe' }, tuning);
      expect((await svc.build(NIFTY_ENTRY as never, TICK, null)).marketBehaviour).toBeUndefined();
    }
  });

  it('MBM_PACKET=observe and the tunable true: the block is in the packet', async () => {
    const tuning = tunable(true);
    const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'observe' }, tuning);
    const p = await svc.build(NIFTY_ENTRY as never, TICK, null);
    expect(p.marketBehaviour).toMatchObject({ available: true, source: 'mbm' });
    expect(tuning.get).toHaveBeenCalledWith('mbm.packet', false);
  });

  it('MBM_PACKET=on alone (env) still shows it, whatever the tunable says', async () => {
    const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'on' }, tunable(false));
    expect((await svc.build(NIFTY_ENTRY as never, TICK, null)).marketBehaviour).toMatchObject({ available: true });
  });

  it('a non-boolean tunable value or a throwing reader never shows it', async () => {
    for (const tuning of [tunable('true'), { get: () => { throw new Error('db down'); } } as TuningReader]) {
      const { svc } = make({ MBM_ENABLED: 'observe', MBM_PACKET: 'observe' }, tuning);
      expect((await svc.build(NIFTY_ENTRY as never, TICK, null)).marketBehaviour).toBeUndefined();
    }
  });
});

describe('packet delta: sinceLastVerdict and ownerHold', () => {
  const since = {
    verdict: 'HOLD', at: new Date(T0.getTime() - 20 * 60_000), reviewInSec: 600, ltp: 118, underlyingLtp: 25080,
    netPnl: 1234.567, triggersThen: ['giveback-off-peak'], newHeadlines: ['x'.repeat(300), 'b', 'c', 'd'],
  };

  it('the block: then/now, age, review due, bounded headlines', () => {
    const b = sinceLastVerdictBlock(since, { at: T0, ltp: 120, underlyingLtp: 25100, netPnl: 1300.004 });
    expect(b).toEqual({
      verdict: 'HOLD', at: since.at.toISOString(), ageMin: 20, reviewInSec: 600, reviewDue: true,
      ltp: { then: 118, now: 120 }, underlyingLtp: { then: 25080, now: 25100 }, netPnl: { then: 1234.57, now: 1300 },
      triggersThen: ['giveback-off-peak'], newHeadlines: ['x'.repeat(120), 'b', 'c'],
    });
    expect(sinceLastVerdictBlock({ ...since, reviewInSec: 3600 }, { at: T0, ltp: 120, underlyingLtp: null, netPnl: 0 }).reviewDue).toBe(false);
  });

  it('build adds both keys only when the review says so; every other block is unchanged', async () => {
    const { svc } = make({});
    const plain = await svc.build(NIFTY_ENTRY as never, TICK, null);
    const withDelta = await svc.build(NIFTY_ENTRY as never, TICK, null, [], { held: true, since });
    expect(plain.sinceLastVerdict).toBeUndefined();
    expect(plain.ownerHold).toBeUndefined();
    expect(withDelta.ownerHold).toBe(true);
    expect(withDelta.sinceLastVerdict?.ltp).toEqual({ then: 118, now: 120 });
    const { sinceLastVerdict: _s, ownerHold: _o, ...rest } = withDelta;
    expect(rest).toEqual(plain);
  });
});

describe('squareOffDecision (the deadline look, SENTINEL_SQUARE_OFF_LOOK)', () => {
  const deadline = {
    deadline: 'SESSION_CLOSE' as const, deadlineIst: '15:30', minutesLeft: 10, look: 'FIRST' as const,
    choice: 'Decide now, 10 min before the NFO close at 15:30 IST: ...',
  };

  it('present exactly as the cycle framed it when the review carries a deadline; absent otherwise (byte-identical)', async () => {
    const { svc } = make({});
    const p = await svc.build(NIFTY_ENTRY as never, TICK, null, [], { deadline });
    expect(p.squareOffDecision).toEqual(deadline);
    expect(JSON.parse(JSON.stringify(p)).squareOffDecision).toEqual(deadline);
    const plain = await svc.build(NIFTY_ENTRY as never, TICK, null, [], {});
    expect('squareOffDecision' in plain).toBe(false);
    expect('squareOffDecision' in (await svc.build(NIFTY_ENTRY as never, TICK, null))).toBe(false);
  });
});
