import { Logger } from '@nestjs/common';
import {
  LADDER_RETRY_MS,
  SentinelCycleService,
  TARGET_LADDER_FIRE,
  TARGET_LADDER_REASON_PREFIX,
  TARGET_LADDER_STAMP,
  storedLadder,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import { parseJudgeGateConfig, type JudgeGateConfig } from './judge-gate';
import type { LadderPlan, LadderPlanReader } from '../ports/ladder-plans.port';

/**
 * TARGET_LADDER in the cycle (owner 2026-11-03, signal trading live): a real position's targets — T1 moves
 * the stop to the entry, T(n) to T(n−1), the last target exits, one target hands over to the noise trail —
 * enforced through a rule EXIT_NOW, exactly like the hard floor.
 */
const USER = 'owner';
const SYMBOL = 'NIFTY04NOV2625000CE';
const ist = (hms: string) => new Date(`2026-11-04T${hms}+05:30`);

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER, trackerId: 't-ce', symbol: SYMBOL, exchange: 'NFO', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
  reason: 'unowned position — sentinel claims it', ...over,
});

const tick = (ltp: number, high: number, over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 100, qty: 75, ltp, underlyingLtp: 25010, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'NIFTY', nearestSupport: 24950, nearestResistance: 25100,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: high, holdingLow: 98,
  entryTime: new Date('2026-11-04T04:20:00.000Z'), expiry: '2026-11-04', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, ...over,
});

const SIGNAL_PLAN: LadderPlan = { targets: [120, 140], riskStop: 90, source: 'signal', detail: 'signal plan (decision d1): T 120 / 140' };

function makeSvc(opts: { reader?: LadderPlanReader | null; plan?: LadderPlan | null; entries?: RosterEntry[]; gate?: JudgeGateConfig; recent?: unknown[]; judged?: boolean } = {}) {
  const planFor = jest.fn().mockResolvedValue(opts.plan === undefined ? SIGNAL_PLAN : opts.plan);
  const reader: LadderPlanReader | null = opts.reader === undefined ? { mode: 'on', planFor } : opts.reader;
  const build = jest.fn().mockResolvedValue(opts.entries ?? [entry()]);
  // judged: a heartbeat look every pass, so a packet (with its money.ladder) is built each time.
  const evaluate = jest.fn().mockReturnValue(opts.judged ? { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' } : { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  const buildPacket = jest.fn().mockImplementation((_e, t) => Promise.resolve({ position: { entryPrice: 100 }, money: { netPnl: 1, greenFloorPrice: null, greenFloorArmed: false, ...(t.ladder ? { ladder: t.ladder } : {}) } }));
  const judge = jest.fn().mockResolvedValue({ verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true, reason: 'fine', evidence: ['money.netPnl'], invalidationPoint: 'x', reviewIn: 90 });
  const record = jest.fn().mockResolvedValue({});
  const recentForTracker = jest.fn().mockResolvedValue(opts.recent ?? []);
  const tickFor = jest.fn();
  const svc = new SentinelCycleService(
    { build } as never, { evaluate } as never, { build: buildPacket } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'LONG', reason: 'signal', levelPrice: 100, targetPrice: 120, invalidation: 90, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v9/t1' } as never, { record, recentForTracker } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never, { tickFor } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, opts.gate, undefined, reader,
  );
  const pass = async (hms: string, t: TickReading) => {
    tickFor.mockResolvedValueOnce(t);
    return svc.runForUser(USER, ist(hms));
  };
  const ladders = () => buildPacket.mock.calls.map((c) => c[1].ladder);
  return { svc, planFor, buildPacket, judge, record, recentForTracker, pass, ladders };
}

const ruleRows = (record: jest.Mock) => record.mock.calls.map((c) => c[0]).filter((r) => r.promptVersion === TARGET_LADDER_STAMP);

describe('SentinelCycleService — TARGET_LADDER', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    // These cases pin the ladder alone; the profit lock has its own case below.
    process.env.PROFIT_LOCK_ARM_RUPEES = '0';
  });
  afterEach(() => {
    delete process.env.PROFIT_LOCK_ARM_RUPEES;
    jest.restoreAllMocks();
  });

  it('PROFIT LOCK: ₹750 open arms a stop keeping half the best profit; a slide through it exits green', async () => {
    process.env.PROFIT_LOCK_ARM_RUPEES = '750';
    const t = makeSvc();
    // best 116 × 75 qty = +₹1,200 open, before T1 120: the lock stop is 108.
    await t.pass('10:00:00', tick(116, 116));
    await t.pass('10:05:00', tick(107.5, 116));
    await t.pass('10:05:30', tick(107, 116));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/TARGET_TRAIL: LTP 107 crossed the ladder stop 108 \(profit lock/);
  });

  it('no reader (paper cycle, TARGET_LADDER=off): no ladder on the packet, no rule exits', async () => {
    const t = makeSvc({ reader: null, judged: true });
    await t.pass('10:00:00', tick(141, 141));
    await t.pass('10:00:30', tick(141, 141));
    expect(ruleRows(t.record)).toHaveLength(0);
    expect(t.buildPacket).toHaveBeenCalled();
    expect(t.buildPacket.mock.calls.every((c) => !('ladder' in c[1]))).toBe(true);
  });

  it('T1 reached → the stop moves to the entry; a pullback through it exits (TARGET_TRAIL) on the second read, once', async () => {
    const t = makeSvc();
    await t.pass('10:00:00', tick(121, 121));
    expect(t.planFor).toHaveBeenCalledTimes(1);
    await t.pass('10:05:00', tick(99.5, 121));
    expect(ruleRows(t.record)).toHaveLength(0);
    await t.pass('10:05:30', tick(99, 121));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'EXIT_NOW', confidence: 'high', triggeredBy: [TARGET_LADDER_FIRE], trackerId: 't-ce' });
    expect(rows[0].reason).toMatch(new RegExp(`^${TARGET_LADDER_REASON_PREFIX.replace(/[()]/g, '\\$&')} TARGET_TRAIL: LTP 99 crossed the ladder stop 100`));
    expect(t.judge).not.toHaveBeenCalled();
    // The rule's packet carries the ladder (the exit gate re-checks it there).
    const [, packetTick, , fires] = t.buildPacket.mock.calls.at(-1)!;
    expect(packetTick.ladder).toMatchObject({ v: 1, source: 'signal', targets: [120, 140], stage: 1, stop: 100, enforced: true });
    expect(fires).toEqual([expect.objectContaining({ name: TARGET_LADDER_FIRE })]);
    // Inside the refire quiet time: no second EXIT_NOW.
    await t.pass('10:06:00', tick(98, 121));
    expect(ruleRows(t.record)).toHaveLength(1);
  });

  it('T2 of two (the last target) exits with TARGET; the plan is read once and frozen', async () => {
    const t = makeSvc();
    await t.pass('10:00:00', tick(141, 141));
    await t.pass('10:00:30', tick(139, 141));
    const rows = ruleRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/TARGET: last target T2 140 reached/);
    expect(t.planFor).toHaveBeenCalledTimes(1);
  });

  it('every packet carries money.ladder; a restart restores the frozen targets and the moved stop from the last packet', async () => {
    const t = makeSvc({ judged: true, plan: { ...SIGNAL_PLAN, targets: [120] } });
    await t.pass('10:00:00', tick(110, 110));
    expect(t.ladders()[0]).toMatchObject({ v: 1, source: 'signal', targets: [120], stage: 0, stop: null, enforced: true });
    // Restart: the last live packet says the one-target trail already sits at 112; the plan is not read
    // again, and the stop is not loosened to the entry by the fresh read (N unknown here).
    const last = { verdict: 'HOLD', createdAt: ist('10:20:00'), packet: { money: { ladder: { ...t.ladders()[0], stage: 1, stop: 112, trailing: true } } } };
    expect(storedLadder(last)).toMatchObject({ targets: [120], stop: 112 });
    const r = makeSvc({ judged: true, recent: [last] });
    await r.pass('10:30:00', tick(118, 124));
    expect(r.planFor).not.toHaveBeenCalled();
    expect(r.ladders()[0]).toMatchObject({ targets: [120], stage: 1, stop: 112, trailing: true });
    // A different cost basis (a repaired entry) voids the stored ladder: targets are set again.
    const moved = makeSvc({ judged: true, recent: [last] });
    await moved.pass('10:30:00', tick(118, 124, { entryPrice: 101 }));
    expect(moved.planFor).toHaveBeenCalledTimes(1);
  });

  it('one target: reaching it does not exit — the trail takes over (at the entry while N is unknown)', async () => {
    const t = makeSvc({ judged: true, plan: { ...SIGNAL_PLAN, targets: [120] } });
    await t.pass('10:00:00', tick(125, 125));
    await t.pass('10:00:30', tick(124, 125));
    expect(ruleRows(t.record)).toHaveLength(0);
    expect(t.ladders().at(-1)).toMatchObject({ stage: 1, trailing: true, stop: 100, lastHit: false });
  });

  it('cash equity: targets shown (enforced false), never exited', async () => {
    const t = makeSvc({ judged: true, entries: [entry({ symbol: 'RELIANCE-EQ', exchange: 'NSE' })] });
    const cash = (ltp: number) => tick(ltp, 141, { segment: 'EQ_INTRADAY', underlyingLtp: ltp });
    await t.pass('10:00:00', cash(141));
    await t.pass('10:00:30', cash(140));
    expect(t.ladders()[0]).toMatchObject({ enforced: false, lastHit: true });
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it('a HELD position (AI_AUTO_EXIT_HOLD) is read but never fired', async () => {
    const t = makeSvc({ gate: parseJudgeGateConfig({ AI_AUTO_EXIT_HOLD: SYMBOL }) });
    await t.pass('10:00:00', tick(141, 141));
    await t.pass('10:00:30', tick(140, 141));
    expect(ruleRows(t.record)).toHaveLength(0);
  });

  it('paper trackers, holdings and other engines\' positions get no ladder', async () => {
    for (const e of [entry({ trackerId: 'paper:pt1' }), entry({ kind: 'HOLDING' }), entry({ ownership: 'OBSERVE_ONLY' })]) {
      const t = makeSvc({ entries: [e] });
      await t.pass('10:00:00', tick(141, 141));
      expect(t.planFor).not.toHaveBeenCalled();
    }
  });

  it('a manual trade whose targets cannot be set yet is asked again after LADDER_RETRY_MS, not every pass', async () => {
    const t = makeSvc({ plan: null });
    await t.pass('10:00:00', tick(105, 105));
    await t.pass('10:00:30', tick(105, 105));
    expect(t.planFor).toHaveBeenCalledTimes(1);
    expect(t.planFor.mock.calls[0][0]).toMatchObject({ trackerId: 't-ce', side: 'LONG', entry: 100, spot: 25010, levels: [24950, 25100], fallbackStop: null });
    await t.pass(`10:0${1 + LADDER_RETRY_MS / 60_000}:00`, tick(105, 105));
    expect(t.planFor).toHaveBeenCalledTimes(2);
  });
});
