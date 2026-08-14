import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SentinelCycleService,
  THESIS_RETRY_COOLDOWN_MS,
  previousFactorValues,
  storedFloorArmed,
  withCashUnderlying,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import type { StoredThesis } from './context-packet.service';
import { HEARTBEAT_INTERVAL_MS } from './tripwire.service';

const USER = 'u1';

const watched = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER,
  trackerId: id,
  symbol: id.toUpperCase(),
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
  ...over,
});

const tick = (over: Partial<TickReading> = {}): TickReading => ({
  segment: 'EQ_INTRADAY',
  side: 'LONG',
  entryPrice: 100,
  qty: 10,
  ltp: 100,
  underlyingLtp: 100,
  nearestSupport: null,
  nearestResistance: null,
  holdingHigh: null,
  holdingLow: null,
  entryTime: new Date('2026-08-14T04:00:00.000Z'),
  expiry: null,
  volumeRatio: null,
  freshNewsCount: null,
  factorValues: {},
  oiWallNow: null,
  oiWallPrev: null,
  ...over,
});

const inferredThesis = (over: Partial<StoredThesis> = {}): StoredThesis => ({
  direction: 'LONG',
  reason: 'bought the retest of the 100 shelf',
  levelPrice: 100,
  targetPrice: 120,
  invalidation: 95,
  source: 'INFERRED',
  ...over,
});

/** The honest-unknown placeholder, exactly as ThesisService writes it. */
const placeholderThesis = (): StoredThesis =>
  inferredThesis({
    reason:
      'thesis could not be inferred — could not reach the Anthropic API. The intent behind ' +
      'this LONG position is UNKNOWN; do not read it as a confirmed setup or judge it against one.',
    levelPrice: null,
    targetPrice: null,
    invalidation: null,
  });

const verdictRow = (over: Record<string, unknown> = {}) => ({
  createdAt: new Date('2026-08-14T05:00:00.000Z'),
  packet: { money: { greenFloorArmed: false }, macro: { realFactors: { available: false } } },
  verdict: 'HOLD',
  reason: 'ok',
  ...over,
});

function makeSvc() {
  const build = jest.fn().mockResolvedValue([]);
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true });
  const buildPacket = jest.fn();
  const ensureFor = jest.fn().mockResolvedValue(inferredThesis());
  const judge = jest.fn();
  const record = jest.fn().mockResolvedValue({});
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const captureAndCompare = jest.fn().mockResolvedValue({ now: null, prev: null });
  const tickFor = jest.fn().mockResolvedValue(tick());

  buildPacket.mockImplementation((_entry, t) =>
    Promise.resolve({
      position: {},
      money: {
        netPnl: 42,
        greenFloorPrice: 101.5,
        // Mirrors the real packet: the latch wins over the per-tick reading.
        greenFloorArmed: t.greenFloorArmedLatched,
      },
    }),
  );
  judge.mockResolvedValue({
    verdict: 'HOLD',
    confidence: 'high',
    thesisStatus: 'INTACT',
    recoveryAvailable: true,
    reason: 'ok',
    evidence: ['money.netPnl'],
    invalidationPoint: 'x',
    reviewIn: 300,
  });

  const svc = new SentinelCycleService(
    { build } as never,
    { evaluate } as never,
    { build: buildPacket } as never,
    { ensureFor } as never,
    { judge, promptVersion: 'sentinel-v3' } as never,
    { record, recentForTracker } as never,
    { captureAndCompare } as never,
    { tickFor } as never,
  );

  return {
    svc,
    build,
    evaluate,
    buildPacket,
    ensureFor,
    judge,
    record,
    recentForTracker,
    captureAndCompare,
    tickFor,
  };
}

/** The TripwireInput the cycle handed the sensors on the nth position. */
const tripwireInput = (evaluate: jest.Mock, n = 0) => evaluate.mock.calls[n][0];

describe('SentinelCycleService — roster gating', () => {
  it('never evaluates an unwatched entry, and does no work for it at all', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1', { watched: false, reason: 'over capacity' })]);

    const report = await t.svc.runForUser(USER);

    expect(t.judge).not.toHaveBeenCalled();
    // An unwatched entry must not even cost a tick fetch or an OI snapshot write:
    // the cap exists to bound work, not merely to bound verdicts.
    expect(t.tickFor).not.toHaveBeenCalled();
    expect(t.captureAndCompare).not.toHaveBeenCalled();
    expect(report).toEqual({ evaluated: 0, skipped: 0, failed: 0, unwatched: 1 });
  });

  it('skips a watched entry when no sensor fired and no heartbeat is due', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false });

    const report = await t.svc.runForUser(USER);

    expect(t.judge).not.toHaveBeenCalled();
    expect(t.ensureFor).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(report).toEqual({ evaluated: 0, skipped: 1, failed: 0, unwatched: 0 });
  });

  it('still captures the OI snapshot on a skipped tick — a gap in the series is an invisible shift', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }));
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false });

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).toHaveBeenCalledTimes(1);
  });

  it('reports one bucket per entry — the four counts always account for the whole roster', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([
      watched('t1'),
      watched('t2'),
      watched('t3', { watched: false }),
      watched('t4'),
    ]);
    t.evaluate
      .mockReturnValueOnce({ fires: [], heartbeat: true, shouldEvaluate: true })
      .mockReturnValueOnce({ fires: [], heartbeat: false, shouldEvaluate: false })
      .mockReturnValueOnce({ fires: [], heartbeat: true, shouldEvaluate: true });
    t.judge.mockRejectedValueOnce(new Error('agent refused'));

    const report = await t.svc.runForUser(USER);

    expect(report).toEqual({ evaluated: 1, skipped: 1, failed: 1, unwatched: 1 });
    expect(report.evaluated + report.skipped + report.failed + report.unwatched).toBe(4);
  });
});

describe('SentinelCycleService — recording a verdict', () => {
  it('records the verdict, the packet, the prompt version and what woke it', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({
      fires: [{ name: 'level-break', detail: 'lost 100' }],
      heartbeat: false,
      shouldEvaluate: true,
    });

    const report = await t.svc.runForUser(USER);

    expect(t.record).toHaveBeenCalledTimes(1);
    const recorded = t.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      userId: USER,
      trackerId: 't1',
      symbol: 'T1',
      verdict: 'HOLD',
      confidence: 'high',
      thesisStatus: 'INTACT',
      recoveryAvailable: true,
      reason: 'ok',
      evidence: ['money.netPnl'],
      invalidationPoint: 'x',
      reviewInSec: 300,
      triggeredBy: ['level-break'],
      netPnl: 42,
      greenFloor: 101.5,
    });
    // Stamped from the agent, never a literal — Task 13 attributes a behaviour
    // change to a prompt change by diffing exactly this field.
    expect(recorded.promptVersion).toBe('sentinel-v3');
    // The packet is stored by reference, as the evidence the agent actually saw.
    expect(recorded.packet).toBe(await t.buildPacket.mock.results[0].value);
    expect(report.evaluated).toBe(1);
  });

  it('names every sensor that fired, not just the first', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({
      fires: [
        { name: 'level-break', detail: 'a' },
        { name: 'volume-anomaly', detail: 'b' },
      ],
      heartbeat: true,
      shouldEvaluate: true,
    });

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].triggeredBy).toEqual(['level-break', 'volume-anomaly']);
  });

  it('attributes a sensorless wake to the heartbeat', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true });

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].triggeredBy).toEqual(['heartbeat']);
  });

  it('takes the tenant from the roster entry, not from the argument', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1', { userId: 'tenant-from-entry' })]);

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].userId).toBe('tenant-from-entry');
  });

  it('passes the last verdict time to the heartbeat clock, and null on first sight', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    expect(t.evaluate.mock.calls[0][1]).toBeNull();
    expect(t.evaluate.mock.calls[0][2]).toBe(now);

    const last = verdictRow();
    t.recentForTracker.mockResolvedValue([last]);
    await t.svc.runForUser(USER, now);
    expect(t.evaluate.mock.calls[1][1]).toBe(last.createdAt);
  });
});

describe('SentinelCycleService — failure isolation', () => {
  it.each([
    ['the tick source', (t: ReturnType<typeof makeSvc>) => t.tickFor],
    ['the agent', (t: ReturnType<typeof makeSvc>) => t.judge],
    ['the packet builder', (t: ReturnType<typeof makeSvc>) => t.buildPacket],
    ['the verdict write', (t: ReturnType<typeof makeSvc>) => t.record],
    ['the OI snapshot', (t: ReturnType<typeof makeSvc>) => t.captureAndCompare],
    ['the thesis service', (t: ReturnType<typeof makeSvc>) => t.ensureFor],
  ])('a failure in %s on one position still evaluates the next', async (_label, pick) => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.tickFor.mockResolvedValue(tick({ segment: 'OPT', expiry: '2026-08-27', underlyingLtp: 24000 }));
    pick(t).mockRejectedValueOnce(new Error('boom'));

    const report = await t.svc.runForUser(USER);

    expect(report.failed).toBe(1);
    expect(report.evaluated).toBe(1);
    // Not merely "counted": the survivor was carried all the way to a written
    // verdict. (Filtered rather than counted, because when the write itself is
    // the injected failure the doomed position also reaches `record` — once.)
    const written = t.record.mock.calls.filter((c) => c[0].trackerId === 't2');
    expect(written).toHaveLength(1);
  });

  it('a roster failure fails the whole run rather than reporting a silent empty cycle', async () => {
    const t = makeSvc();
    t.build.mockRejectedValue(new Error('trade-tracker down'));

    await expect(t.svc.runForUser(USER)).rejects.toThrow('trade-tracker down');
  });
});

describe('SentinelCycleService — shadow mode is structural', () => {
  const source = readFileSync(join(__dirname, 'sentinel-cycle.service.ts'), 'utf8');

  it('imports nothing that can place an order', () => {
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).not.toMatch(/execution|order|broker|angel|smart-?api|trade-engine|auto-trade/i);
    }
  });

  it('exposes no method through which an order could be placed', () => {
    const t = makeSvc();
    const surface = [
      ...Object.getOwnPropertyNames(t.svc),
      ...Object.getOwnPropertyNames(SentinelCycleService.prototype),
    ];
    for (const name of surface) {
      expect(name).not.toMatch(/execute|placeOrder|squareOff|exitPosition|closePosition|submit/i);
    }
  });

  it('injects nothing that could place an order', () => {
    // Read off the constructor's emitted paramtypes rather than a hand-kept list,
    // so ADDING an order-placing collaborator fails this test rather than needing
    // someone to remember to extend it.
    const injected: unknown[] =
      (Reflect as { getMetadata?: (k: string, t: unknown) => unknown[] }).getMetadata?.(
        'design:paramtypes',
        SentinelCycleService,
      ) ?? [];
    expect(injected).toHaveLength(8);

    for (const dep of injected) {
      if (typeof dep !== 'function') continue; // `TickSource` is an interface: emitted as Object.
      const name = (dep as { name: string }).name;
      expect(name).not.toMatch(/execution|order|broker|trade-?engine|auto-?trade/i);
      for (const method of Object.getOwnPropertyNames((dep as { prototype: object }).prototype)) {
        expect(method).not.toMatch(/^(execute|placeOrder|squareOff|cancelOrder|modifyOrder)$/i);
      }
    }
  });
});

describe('previousFactorValues', () => {
  it('is empty with no previous verdict — nothing can have flipped on first sight', () => {
    expect(previousFactorValues(undefined)).toEqual({});
    expect(previousFactorValues(null)).toEqual({});
  });

  it('is empty when the previous packet stated the factors were unavailable', () => {
    expect(
      previousFactorValues({ packet: { macro: { realFactors: { available: false, reason: 'x' } } } }),
    ).toEqual({});
  });

  it('returns the finite readings the agent last saw', () => {
    expect(
      previousFactorValues({
        packet: { macro: { realFactors: { available: true, value: { mtfTrend: 0.4, iv: -0.2 } } } },
      }),
    ).toEqual({ mtfTrend: 0.4, iv: -0.2 });
  });

  it('drops non-finite and non-numeric readings — a NaN baseline manufactures a flip', () => {
    expect(
      previousFactorValues({
        packet: {
          macro: {
            realFactors: {
              available: true,
              value: { good: 0.5, nan: NaN, inf: Infinity, text: '0.5', nil: null },
            },
          },
        },
      }),
    ).toEqual({ good: 0.5 });
  });

  it.each([
    ['a null packet', { packet: null }],
    ['a string packet', { packet: 'corrupt' }],
    ['a packet with no macro', { packet: {} }],
    ['an array-valued factor block', { packet: { macro: { realFactors: { available: true, value: [1, 2] } } } }],
    ['a null-valued factor block', { packet: { macro: { realFactors: { available: true, value: null } } } }],
  ])('degrades %s to no baseline rather than throwing', (_label, last) => {
    expect(previousFactorValues(last)).toEqual({});
  });

  it('is actually wired: the sensors receive the previous packet as their baseline', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.recentForTracker.mockResolvedValue([
      verdictRow({
        packet: {
          money: { greenFloorArmed: false },
          macro: { realFactors: { available: true, value: { mtfTrend: 0.8 } } },
        },
      }),
    ]);
    t.tickFor.mockResolvedValue(tick({ factorValues: { mtfTrend: -0.8 } }));

    await t.svc.runForUser(USER);

    // The bug this guards: an earlier draft hardcoded `prevFactorValues: {}`, so
    // contextFactorFlip could never fire no matter what the factors did.
    expect(tripwireInput(t.evaluate).prevFactorValues).toEqual({ mtfTrend: 0.8 });
    expect(tripwireInput(t.evaluate).factorValues).toEqual({ mtfTrend: -0.8 });
  });
});

describe('SentinelCycleService — the green-floor latch', () => {
  /** entry 100 x 10 at ltp 120 nets ~₹193, well clear of the ₹150 margin. */
  const ARMED_LTP = 120;

  it('does not claim a floor that has never armed', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(false);
  });

  it('arms on the tick that clears the margin', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('stays armed through a pullback back into the red', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);

    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    await t.svc.runForUser(USER);

    // The position gives it all back and is now LOSING. The floor must not un-arm.
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(true);
  });

  it('latches an arming that happened on a tick no verdict was written for', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);

    // Tick 1: armed, but every sensor quiet and the heartbeat not due — no verdict
    // row exists to carry the latch, so only the in-process ratchet can hold it.
    t.evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false });
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    await t.svc.runForUser(USER);
    expect(t.buildPacket).not.toHaveBeenCalled();

    // Tick 2: pulled back below the margin, heartbeat due.
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true });
    t.tickFor.mockResolvedValue(tick({ ltp: 101 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('recovers the latch from the last stored packet after a restart', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    // Fresh instance: no in-process state at all. A LOSING position whose floor
    // armed before the restart.
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    t.recentForTracker.mockResolvedValue([
      verdictRow({ packet: { money: { greenFloorArmed: true } } }),
    ]);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
  });

  it('does not invent a latch from an unreadable stored packet', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));
    t.recentForTracker.mockResolvedValue([verdictRow({ packet: 'corrupt' })]);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(false);
  });

  it('does not leak one position’s latch onto another', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.tickFor.mockImplementation((id: string) =>
      Promise.resolve(tick({ ltp: id === 't1' ? ARMED_LTP : 100 })),
    );

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][1].greenFloorArmedLatched).toBe(true);
    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(false);
  });

  it('forgets a tracker once it leaves the roster, so a reused id starts clean', async () => {
    const t = makeSvc();
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    t.build.mockResolvedValue([watched('t1')]);
    await t.svc.runForUser(USER);

    // Position closed — off the roster entirely.
    t.build.mockResolvedValue([]);
    await t.svc.runForUser(USER);

    // A new position on the same tracker id, unarmed and with no verdict history.
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ ltp: 100 }));
    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(false);
  });

  it('keeps another tenant’s state when pruning this one', async () => {
    const t = makeSvc();
    t.tickFor.mockResolvedValue(tick({ ltp: ARMED_LTP }));
    t.build.mockResolvedValue([watched('t9', { userId: 'other' })]);
    await t.svc.runForUser('other');

    // A run for a different tenant must not sweep 'other's tracker out.
    t.build.mockResolvedValue([]);
    await t.svc.runForUser(USER);

    t.build.mockResolvedValue([watched('t9', { userId: 'other' })]);
    t.tickFor.mockResolvedValue(tick({ ltp: 90 }));
    await t.svc.runForUser('other');

    expect(t.buildPacket.mock.calls[1][1].greenFloorArmedLatched).toBe(true);
  });
});

describe('storedFloorArmed', () => {
  it.each([
    ['no verdict', undefined, false],
    ['an armed packet', { packet: { money: { greenFloorArmed: true } } }, true],
    ['an unarmed packet', { packet: { money: { greenFloorArmed: false } } }, false],
    ['a missing money block', { packet: {} }, false],
    ['a truthy non-boolean', { packet: { money: { greenFloorArmed: 'yes' } } }, false],
    ['a corrupt packet', { packet: 7 }, false],
  ])('reads %s as %s', (_label, last, expected) => {
    expect(storedFloorArmed(last as { packet?: unknown } | undefined)).toBe(expected);
  });
});

describe('withCashUnderlying', () => {
  it.each(['EQ_DELIVERY', 'EQ_INTRADAY'] as const)(
    'gives a %s tick an underlying equal to its own ltp',
    (segment) => {
      const out = withCashUnderlying(tick({ segment, ltp: 1450, underlyingLtp: null }));
      expect(out.underlyingLtp).toBe(1450);
    },
  );

  it.each(['OPT', 'FUT'] as const)(
    'leaves a %s tick without an underlying — the premium is not the spot',
    (segment) => {
      const out = withCashUnderlying(tick({ segment, ltp: 120, underlyingLtp: null }));
      expect(out.underlyingLtp).toBeNull();
    },
  );

  it('does not overwrite an underlying the source already resolved', () => {
    const out = withCashUnderlying(tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: 1449 }));
    expect(out.underlyingLtp).toBe(1449);
  });

  it('repairs a NaN underlying, which is not a reading either', () => {
    const out = withCashUnderlying(tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: NaN }));
    expect(out.underlyingLtp).toBe(1450);
  });

  it('is wired: an equity position reaches the sensors with a comparable underlying', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'EQ_INTRADAY', ltp: 1450, underlyingLtp: null, nearestSupport: 1440 }),
    );

    await t.svc.runForUser(USER);

    // Without this, levelBreak is silent on EVERY equity position and it looks
    // exactly like the level was never touched.
    expect(tripwireInput(t.evaluate).underlyingLtp).toBe(1450);
  });
});

describe('SentinelCycleService — OI walls', () => {
  it('does not snapshot a symbol with no expiry', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ expiry: null }));

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).not.toHaveBeenCalled();
    expect(tripwireInput(t.evaluate).oiWallNow).toBeNull();
  });

  it('passes the symbol, the expiry and the UNDERLYING spot — never the premium', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', ltp: 120, underlyingLtp: 24000, expiry: '2026-08-27' }),
    );

    await t.svc.runForUser(USER);

    // Three required arguments. A premium here would keep ITM strikes and write a
    // mis-sided wall that poisons the next comparison.
    expect(t.captureAndCompare).toHaveBeenCalledWith('T1', '2026-08-27', 24000);
  });

  it('passes a null spot through as null rather than substituting the premium', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', ltp: 120, underlyingLtp: null, expiry: '2026-08-27' }),
    );

    await t.svc.runForUser(USER);

    expect(t.captureAndCompare).toHaveBeenCalledWith('T1', '2026-08-27', null);
  });

  it('feeds the captured walls to both the sensors and the packet', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(
      tick({ segment: 'OPT', underlyingLtp: 24000, expiry: '2026-08-27' }),
    );
    const now = { callWall: 24200, putWall: 23800 };
    const prev = { callWall: 24500, putWall: 23800 };
    t.captureAndCompare.mockResolvedValue({ now, prev });

    await t.svc.runForUser(USER);

    expect(tripwireInput(t.evaluate).oiWallNow).toBe(now);
    expect(tripwireInput(t.evaluate).oiWallPrev).toBe(prev);
    // The packet must see the same walls the sensor fired on, not the tick's stale nulls.
    expect(t.buildPacket.mock.calls[0][1].oiWallNow).toBe(now);
    expect(t.buildPacket.mock.calls[0][1].oiWallPrev).toBe(prev);
  });
});

describe('SentinelCycleService — thesis', () => {
  it('calls ensureFor with the entry and the tick — the userId argument is gone', async () => {
    const t = makeSvc();
    const entry = watched('t1');
    t.build.mockResolvedValue([entry]);

    await t.svc.runForUser(USER);

    expect(t.ensureFor).toHaveBeenCalledTimes(1);
    expect(t.ensureFor.mock.calls[0]).toHaveLength(2);
    expect(t.ensureFor.mock.calls[0][0]).toBe(entry);
    expect(t.ensureFor.mock.calls[0][1]).toMatchObject({ side: 'LONG', entryPrice: 100, qty: 10 });
  });

  it('hands the thesis to the packet builder, keeping the disagreement flag', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const ensured = { ...inferredThesis(), modelDirectionDisagreed: true as const };
    t.ensureFor.mockResolvedValue(ensured);

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][2]).toBe(ensured);
    expect(t.buildPacket.mock.calls[0][2].modelDirectionDisagreed).toBe(true);
  });

  it('hands the fires to the packet builder as the trigger', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const fires = [{ name: 'news-hit', detail: '3 headlines' }];
    t.evaluate.mockReturnValue({ fires, heartbeat: false, shouldEvaluate: true });

    await t.svc.runForUser(USER);

    expect(t.buildPacket.mock.calls[0][3]).toBe(fires);
  });

  it('re-asks on every look while the thesis is real, so a user correction lands at once', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('does not re-infer a placeholder thesis at tick cadence', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue(placeholderThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    // Ten seconds later, and again a minute later. ensureFor re-infers on EVERY
    // call while the stored thesis is the placeholder, with no cooldown of its
    // own — the cadence has to be held here.
    await t.svc.runForUser(USER, new Date(now.getTime() + 10_000));
    await t.svc.runForUser(USER, new Date(now.getTime() + 60_000));

    expect(t.ensureFor).toHaveBeenCalledTimes(1);
    // The held-back look still gets a thesis — a stale placeholder, never nothing.
    expect(t.buildPacket).toHaveBeenCalledTimes(3);
    expect(t.buildPacket.mock.calls[2][2].reason).toMatch(/^thesis could not be inferred/);
  });

  it('tries again once the cooldown has elapsed', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue(placeholderThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('resumes asking as soon as inference succeeds', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const now = new Date('2026-08-14T06:00:00.000Z');

    t.ensureFor.mockResolvedValueOnce(placeholderThesis());
    await t.svc.runForUser(USER, now);

    // Held back...
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));
    expect(t.ensureFor).toHaveBeenCalledTimes(1);

    // ...until the cooldown lapses and a real thesis comes back, after which
    // there is nothing left to hold back.
    t.ensureFor.mockResolvedValue(inferredThesis());
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS));
    await t.svc.runForUser(USER, new Date(now.getTime() + THESIS_RETRY_COOLDOWN_MS + 1000));
    expect(t.ensureFor).toHaveBeenCalledTimes(3);
  });

  it('never holds back a USER correction, even one that reads like the placeholder', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.ensureFor.mockResolvedValue({ ...placeholderThesis(), source: 'USER' });
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    expect(t.ensureFor).toHaveBeenCalledTimes(2);
  });

  it('cools down each position independently', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1'), watched('t2')]);
    t.ensureFor.mockResolvedValueOnce(placeholderThesis()).mockResolvedValue(inferredThesis());
    const now = new Date('2026-08-14T06:00:00.000Z');

    await t.svc.runForUser(USER, now);
    await t.svc.runForUser(USER, new Date(now.getTime() + 1000));

    // t1 held back, t2 re-asked: 2 on the first run, 1 on the second.
    expect(t.ensureFor).toHaveBeenCalledTimes(3);
    expect(t.ensureFor.mock.calls[2][0].trackerId).toBe('t2');
  });

  it('is set to the heartbeat cadence — one inference attempt per scheduled look', () => {
    expect(THESIS_RETRY_COOLDOWN_MS).toBe(HEARTBEAT_INTERVAL_MS);
  });
});
