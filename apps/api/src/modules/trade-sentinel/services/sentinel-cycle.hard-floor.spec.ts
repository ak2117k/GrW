import { Logger } from '@nestjs/common';
import { FLOOR_HARD_EXIT_FIRE, FLOOR_HARD_EXIT_REASON_PREFIX, FLOOR_HARD_EXIT_STAMP, SentinelCycleService, type TickReading } from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import { parseExitDisciplineConfig, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { parseJudgeGateConfig, type JudgeGateConfig } from './judge-gate';

/**
 * FLOOR_HARD_EXIT in the cycle — prod 2026-10-29, the owner's CRUDEOILM17NOV269350PE (2 lots,
 * entry 362.55): peak 380.4, noise floor 376.8, crude ground up from 9531 while every verdict HELD.
 */
const USER = 'u1';
const SYMBOL = 'CRUDEOILM17NOV269350PE';
const ist = (hms: string) => new Date(`2026-10-29T${hms}+05:30`);

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER, trackerId: 't-pe', symbol: SYMBOL, exchange: 'MCX', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
  reason: 'unowned position — sentinel claims it', ...over,
});

const noise = (at: string) => ({
  contract: { n: 1.8, method: 'atr14-1m' as const, bars: 60, at },
  underlying1m: { n: 12.5, method: 'atr14-1m' as const, bars: 60, at },
  reason: null,
});

const tick = (ltp: number, underlying: number, high = 380.4): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 362.55, qty: 20, ltp, underlyingLtp: underlying, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'CRUDEOILM', nearestSupport: 9500, nearestResistance: 9620,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: high, holdingLow: 362.55,
  entryTime: new Date('2026-10-29T14:40:00.000Z'), expiry: '2026-11-17', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, noise: noise('2026-10-29T15:30:00.000Z'),
});

function makeSvc(discipline: ExitDisciplineConfig | undefined, gate?: JudgeGateConfig) {
  const build = jest.fn().mockResolvedValue([entry()]);
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  const buildPacket = jest.fn().mockImplementation((_e, t) =>
    Promise.resolve({ position: { entryPrice: 362.55 }, money: { netPnl: 1, greenFloorPrice: t.noiseFloor?.level ?? null, greenFloorArmed: !!t.noiseFloor?.armed } }));
  const judge = jest.fn().mockResolvedValue({
    verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true, reason: 'only 6 points against me since my last HOLD',
    evidence: ['money.netPnl'], invalidationPoint: 'x', reviewIn: 90,
  });
  const record = jest.fn().mockResolvedValue({});
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const tickFor = jest.fn();
  const svc = new SentinelCycleService(
    { build } as never, { evaluate } as never, { build: buildPacket } as never, { ensureFor: jest.fn().mockResolvedValue({ direction: 'SHORT', reason: 'long put', levelPrice: 9560, targetPrice: 9480, invalidation: 9650, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v9/t1' } as never, { record, recentForTracker } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never, { tickFor } as never,
    undefined, discipline, undefined, undefined, undefined, undefined, undefined, undefined, gate,
  );
  /** One cycle pass at `hms` IST over `t`; resolves once its work (judgement or rule verdict) is recorded. */
  const pass = async (hms: string, t: TickReading) => {
    tickFor.mockResolvedValueOnce(t);
    return svc.runForUser(USER, ist(hms));
  };
  return { svc, build, evaluate, buildPacket, judge, record, recentForTracker, pass };
}

const ruleRows = (record: jest.Mock) => record.mock.calls.map((c) => c[0]).filter((r) => r.promptVersion === FLOOR_HARD_EXIT_STAMP);

describe('SentinelCycleService — FLOOR_HARD_EXIT', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('anchors the best point once, never at a later verdict, and hands money.anchors to the packet', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:12:00', tick(375, 9550));
    const anchors = t.buildPacket.mock.calls.map((c) => c[1].anchors);
    expect(anchors[0]).toMatchObject({ best: { ltp: 380.4, underlying: 9531 }, hardExitN: 2 });
    expect(anchors[0].floorArm).toMatchObject({ ltp: 380.4, underlying: 9531 }); // first seen armed at this pass
    expect(anchors[1]).toEqual(anchors[0]); // the 21:12 HOLD did not move either anchor
  });

  it('fires on the second consecutive tripping read: records an EXIT_NOW without asking the judge, then stays quiet while it runs', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    // Below the floor 376.8 but still net green, crude 1.5 N against: no trip.
    await t.pass('21:12:00', tick(375, 9550));
    // 21:15:00 crude 9557 = 2.08 N against from 9531: the first trip — not a fire.
    await t.pass('21:15:00', tick(371.3, 9557));
    expect(ruleRows(t.record)).toHaveLength(0);
    await t.pass('21:15:30', tick(371.2, 9557.5));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER, trackerId: 't-pe', symbol: SYMBOL, verdict: 'EXIT_NOW', confidence: 'high',
      triggeredBy: [FLOOR_HARD_EXIT_FIRE], invalidationPoint: null,
    });
    expect(rows[0].reason).toMatch(new RegExp(`^${FLOOR_HARD_EXIT_REASON_PREFIX.replace(/[()]/g, '\\$&')} HWM_UNDERLYING_MOVE: premium 371.2 below the armed floor 376.8`));
    expect(rows[0].evidence).toContain('money.anchors');
    expect(t.judge).not.toHaveBeenCalled();
    // The rule's packet carries the anchors and the fire, from the cached thesis (no new inference).
    const [, packetTick, , fires] = t.buildPacket.mock.calls.at(-1)!;
    expect(packetTick.anchors.best).toMatchObject({ ltp: 380.4, underlying: 9531 });
    expect(fires).toEqual([expect.objectContaining({ name: FLOOR_HARD_EXIT_FIRE })]);
    // Still tripped 30 s and 90 s later: no second EXIT_NOW inside the refire quiet time.
    await t.pass('21:16:00', tick(370.5, 9560));
    await t.pass('21:17:00', tick(369, 9563));
    expect(ruleRows(t.record)).toHaveLength(1);
  });

  it('a green trade below the floor with the underlying under K·N from the best point never hard-exits', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    for (const [hms, ltp, u] of [['21:10:00', 376, 9545], ['21:10:30', 375.5, 9547], ['21:11:00', 375, 9550], ['21:11:30', 374.8, 9552]] as const) {
      await t.pass(hms, tick(ltp, u));
    }
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it('GREEN_TO_RED: the floor broken and net red fires even with the underlying move unmeasurable', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    const red = (ltp: number): TickReading => ({ ...tick(ltp, 9545), noise: { ...noise('x'), underlying1m: null } });
    await t.pass('21:20:00', red(364));
    await t.pass('21:20:30', red(363.8));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/GREEN_TO_RED: premium 363.8 below the armed floor 376.8 and net ₹-?\d+ — the trade turned red/);
  });

  it('one tripping read that recovers on the next never fires (the confirmation resists a single print)', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:15:00', tick(371.3, 9557));
    await t.pass('21:15:30', tick(377, 9540));
    await t.pass('21:16:00', tick(371.3, 9557));
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it.each([
    ['FLOOR_HARD_EXIT=false', parseExitDisciplineConfig({ FLOOR_HARD_EXIT: 'false' }), {}],
    ['exit discipline off', parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }), {}],
    ['a position another engine manages', parseExitDisciplineConfig({}), { ownership: 'OBSERVE_ONLY' as const }],
    ['a cash position (the executor never exits it)', parseExitDisciplineConfig({}), { exchange: 'NSE' }],
  ])('%s: no rule verdict', async (_l, cfg, over) => {
    const t = makeSvc(cfg);
    t.build.mockResolvedValue([entry(over)]);
    const cash = (x: TickReading): TickReading => ('exchange' in over ? { ...x, segment: 'EQ_INTRADAY', underlyingLtp: x.ltp } : x);
    await t.pass('21:00:00', cash(tick(380.4, 9531)));
    await t.pass('21:20:00', cash(tick(364, 9600)));
    await t.pass('21:20:30', cash(tick(363.8, 9601)));
    expect(ruleRows(t.record)).toHaveLength(0);
    if (cfg.floorHardExit === false || !cfg.enabled) expect(t.buildPacket.mock.calls.every((c) => c[1].anchors === undefined)).toBe(true);
  });

  it('a HELD position (AI_AUTO_EXIT_HOLD) is never fired — the executor would refuse it anyway', async () => {
    const gate = parseJudgeGateConfig({ AI_AUTO_EXIT_HOLD: SYMBOL });
    const t = makeSvc(parseExitDisciplineConfig({}), gate);
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:20:00', tick(364, 9600));
    await t.pass('21:20:30', tick(363.8, 9601));
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it('a failed write is retried on the next confirming pass', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:15:00', tick(371.3, 9557));
    t.record.mockRejectedValueOnce(new Error('db down'));
    await t.pass('21:15:30', tick(371.2, 9557.5));
    await t.pass('21:16:00', tick(370.5, 9560));
    expect(t.record).toHaveBeenCalledTimes(2);
    expect(ruleRows(t.record)).toHaveLength(2);
  });
});

describe('SentinelCycleService — judge gate: at most one judgement a minute per position (prod 2026-10-29 same-minute pairs)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const fire = (name: string) => ({ name, detail: name });

  it('a wake within MIN_REJUDGE_GAP_MS of the latest verdict waits; its edge-triggered fire is carried and judged after the gap', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}), parseJudgeGateConfig({}));
    const recent = t.recentForTracker;
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('21:00:00', tick(380.4, 9531)); // first look
    expect(t.judge).toHaveBeenCalledTimes(1);
    const hold = { createdAt: ist('21:00:20'), verdict: 'HOLD', reason: 'ok', packet: { money: { greenFloorArmed: true } } };
    recent.mockResolvedValue([hold]);
    // 30 s after that HOLD: the armed floor is breached (the cap is bypassed) and two sensors fire.
    t.evaluate.mockReturnValueOnce({ fires: [fire('oi-wall-shift'), fire('giveback-off-peak')], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.pass('21:00:50', tick(375, 9545));
    expect(t.judge).toHaveBeenCalledTimes(1);
    // 70 s after it, nothing new fired: the carried OI fire is judged now — the level-triggered giveback was not carried.
    t.evaluate.mockReturnValueOnce({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
    await t.pass('21:01:30', tick(375, 9545));
    expect(t.judge).toHaveBeenCalledTimes(2);
    const fires = t.buildPacket.mock.calls.at(-1)![3] as Array<{ name: string }>;
    expect(fires.map((f) => f.name)).toEqual(['oi-wall-shift']);
  });

  it('judge gate off: no gap (the rollback is byte-for-byte the old dispatch)', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    const recent = t.recentForTracker;
    recent.mockResolvedValue([{ createdAt: ist('21:00:20'), verdict: 'HOLD', reason: 'ok', packet: {} }]);
    t.evaluate.mockReturnValue({ fires: [fire('oi-wall-shift')], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.pass('21:00:50', tick(375, 9545));
    expect(t.judge).toHaveBeenCalledTimes(1);
  });
});
