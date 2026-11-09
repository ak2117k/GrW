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

  /** The 2026-10-29 rules: a green floor break waits for K·N (FLOOR_LOCK_GREEN off). */
  const NO_LOCK = () => parseExitDisciplineConfig({ FLOOR_LOCK_GREEN: 'false' });

  it('fires on the second consecutive tripping read: records an EXIT_NOW without asking the judge, then stays quiet while it runs', async () => {
    const t = makeSvc(NO_LOCK());
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

  it('green lock off: a green trade below the floor with the underlying under K·N from the best point never hard-exits', async () => {
    const t = makeSvc(NO_LOCK());
    await t.pass('21:00:00', tick(380.4, 9531));
    for (const [hms, ltp, u] of [['21:10:00', 376, 9545], ['21:10:30', 375.5, 9547], ['21:11:00', 375, 9550], ['21:11:30', 374.8, 9552]] as const) {
      await t.pass(hms, tick(ltp, u));
    }
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it('FLOOR_BREAK_GREEN (2026-11-04): the same green break under K·N fires once confirmed, naming the green lock', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    await t.pass('21:00:00', tick(380.4, 9531));
    await t.pass('21:10:00', tick(376, 9545));
    expect(ruleRows(t.record)).toHaveLength(0);
    await t.pass('21:10:30', tick(375.5, 9547));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/FLOOR_BREAK_GREEN: premium 375.5 below the armed floor 376.8 while net ₹\d+ is still green/);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('SPIKE BANK (2026-11-04): a fast new best latches money.spike and the floor trails it by 1 N instead of 2 N', async () => {
    const t = makeSvc(parseExitDisciplineConfig({}));
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    const bars = [{ ts: ist('20:59:00').getTime(), open: 370, high: 371, low: 369, close: 370 }];
    await t.pass('21:00:00', { ...tick(370, 9545, 370), contractBars: bars });
    await t.pass('21:01:00', { ...tick(380.4, 9531, 380.4), contractBars: bars });
    const last = t.buildPacket.mock.calls.at(-1)![1];
    expect(last.spike).toMatchObject({ latched: true, from: 369, to: 380.4, trailN: 1, n: 1.8 });
    expect(last.noiseFloor.level).toBeCloseTo(380.4 - 1.8, 2);
    // Without it (FLOOR_SPIKE_BANK=false) the same passes trail by 2 N and the packet has no money.spike.
    const off = makeSvc(parseExitDisciplineConfig({ FLOOR_SPIKE_BANK: 'false' }));
    off.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await off.pass('21:00:00', { ...tick(370, 9545, 370), contractBars: bars });
    await off.pass('21:01:00', { ...tick(380.4, 9531, 380.4), contractBars: bars });
    const offLast = off.buildPacket.mock.calls.at(-1)![1];
    expect(offLast.spike).toBeUndefined();
    expect(offLast.noiseFloor.level).toBeCloseTo(380.4 - 3.6, 2);
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

describe('SentinelCycleService — noise-aware HARD_LOSS_EXIT (prod 2026-11-04 NIFTY09NOV2623750PE, 2 lots, entry 159.15)', () => {
  const NIFTY = 'NIFTY09NOV2623750PE';
  const at = (hms: string) => new Date(`2026-11-04T${hms}+05:30`);
  const nifty = (ltp: number, underlying: number, over: Partial<TickReading> = {}): TickReading => ({
    ...tick(ltp, underlying, 159.55), entryPrice: 159.15, qty: 130, holdingHigh: 159.55, holdingLow: ltp, structureSymbol: 'NIFTY',
    entryTime: new Date('2026-11-04T05:45:39.825Z'), expiry: '2026-11-09', entryUnderlying: 23812.25,
    noise: { contract: { n: 4.2, method: 'atr14-1m', bars: 60, at: 'x' }, underlying1m: { n: 10.73, method: 'atr14-1m', bars: 60, at: 'x' }, reason: null },
    ...over,
  });
  const ENV = { ...process.env };
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env.HARD_LOSS_EXIT_RUPEES = '2000';
    process.env.HARD_LOSS_BY_TRADE_VALUE = 'off'; // this block tests the noise band, which is the rollback path
    delete process.env.HARD_LOSS_CAP_RUPEES;
    delete process.env.HARD_LOSS_NOISE_N;
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });
  const run = async (env: Record<string, string>, reads: Array<[string, TickReading]>) => {
    Object.assign(process.env, env);
    const t = makeSvc(parseExitDisciplineConfig({}));
    t.build.mockResolvedValue([entry({ symbol: NIFTY, exchange: 'NFO', trackerId: 't-nifty' })]);
    for (const [hms, r] of reads) {
      await t.pass(hms, r);
    }
    return ruleRows(t.record);
  };
  // 11:19:00 / 11:19:30 IST: premium 142.1, net ≈ −₹2299, NIFTY 23834.1 = 2.04 N against from the entry close.
  const AT_2K: Array<[string, TickReading]> = [['11:19:00', nifty(142.1, 23834.1)], ['11:19:30', nifty(142.1, 23834.1)]];

  it('regression: the −₹2299 read that sold the trade at 11:19:30 is now HELD (NIFTY only 2.04 N from entry)', async () => {
    expect(await run({}, AT_2K)).toHaveLength(0);
  });

  it('before 2026-11-04 (HARD_LOSS_NOISE_N=0): the same reads exit by the plain ₹2k rule, exactly as in prod', async () => {
    const rows = await run({ HARD_LOSS_NOISE_N: '0' }, AT_2K);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/MAX_LOSS: net ₹-2\d{3} reached the hard loss exit of ₹2000 \(HARD_LOSS_EXIT_RUPEES\)/);
  });

  it('in the band, NIFTY ≥ 3 N against from entry exits, naming the move', async () => {
    const rows = await run({}, [['11:20:00', nifty(140, 23845)], ['11:20:30', nifty(140, 23845)]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/MAX_LOSS: net ₹-2\d{3} is past the hard loss exit of ₹2000 and the underlying 23845 is 32.75 \(3.05 N\) against the position from entry/);
  });

  it('the ₹3000 cap exits with the underlying still inside noise', async () => {
    const rows = await run({}, [['11:21:00', nifty(135.5, 23830)], ['11:21:30', nifty(135.5, 23830)]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/MAX_LOSS: net ₹-3\d{3} reached the absolute hard loss cap of ₹3000 \(HARD_LOSS_CAP_RUPEES\)/);
  });

  it('fail safe: no underlying noise unit ⇒ the plain ₹2k rule exits', async () => {
    const noN = (r: TickReading): TickReading => ({ ...r, noise: { ...r.noise!, underlying1m: null } });
    const rows = await run({}, AT_2K.map(([h, r]) => [h, noN(r)] as [string, TickReading]));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/the underlying's move is unmeasurable, so the plain rule applies/);
  });

  it('a paper trade is untouched (no hard loss rule)', async () => {
    Object.assign(process.env, {});
    const t = makeSvc(parseExitDisciplineConfig({}));
    t.build.mockResolvedValue([entry({ symbol: NIFTY, exchange: 'NFO', trackerId: 'paper:abc' })]);
    for (const [hms, r] of [['11:21:00', nifty(130, 23830)], ['11:21:30', nifty(130, 23830)]] as Array<[string, TickReading]>) await t.pass(hms, r);
    expect(ruleRows(t.record).filter((r) => /MAX_LOSS/.test(r.reason))).toHaveLength(0);
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
    // Green lock off: this pass's green floor break would otherwise exit by rule before the judge (FLOOR_BREAK_GREEN).
    const t = makeSvc(parseExitDisciplineConfig({ FLOOR_LOCK_GREEN: 'false' }), parseJudgeGateConfig({}));
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
