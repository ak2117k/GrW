import { Logger } from '@nestjs/common';
import {
  FLOOR_HARD_EXIT_REASON_PREFIX,
  FLOOR_HARD_EXIT_STAMP,
  SentinelCycleService,
  TARGET_LADDER_REASON_PREFIX,
  TARGET_LADDER_STAMP,
  type TickReading,
} from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import { parseExitDisciplineConfig, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { parseJudgeGateConfig, type JudgeGateConfig } from './judge-gate';
import type { LadderPlan, LadderPlanReader } from '../ports/ladder-plans.port';
import type { AlarmRow, RaiseAlarm } from '../../exit-authority/exit-authority.tokens';
import { ALARM_FIRE } from './alarm-look';

/**
 * TRADE AGENT EXIT AUTHORITY (2026-11-27), the sentinel side: with the authority live, the four code rules that sold a
 * live trade (HARD_LOSS, HARD_LOSS_FAST, FLOOR, LADDER) raise an alarm instead of an EXIT_NOW; an open alarm forces
 * the agent's look past every wake gate; the packet carries the alarm and the brief. Off / paper ⇒ exactly as before.
 */
const USER = 'u1';
const SYMBOL = 'CRUDEOILM17NOV269350PE';
const ist = (hms: string) => new Date(`2026-10-29T${hms}+05:30`);

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER, trackerId: 't-pe', symbol: SYMBOL, exchange: 'MCX', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
  reason: 'unowned position — sentinel claims it', ...over,
});

const noise = {
  contract: { n: 1.8, method: 'atr14-1m' as const, bars: 60, at: 'x' },
  underlying1m: { n: 12.5, method: 'atr14-1m' as const, bars: 60, at: 'x' },
  reason: null,
};

const tick = (ltp: number, underlying: number, high = 380.4, over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 362.55, qty: 20, ltp, underlyingLtp: underlying, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'CRUDEOILM', nearestSupport: 9500, nearestResistance: 9620,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: high, holdingLow: 362.55,
  entryTime: new Date('2026-10-29T14:40:00.000Z'), expiry: '2026-11-17', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, noise, ...over,
});

interface Opts {
  discipline?: ExitDisciplineConfig;
  gate?: JudgeGateConfig;
  live?: boolean;
  /** Bind the ports at all (false ⇒ the module without exit authority). */
  ports?: boolean;
  entries?: RosterEntry[];
  reader?: LadderPlanReader | null;
  open?: AlarmRow[];
  recent?: unknown[];
  brief?: string | null;
  /** The alarm chart reader: undefined ⇒ none bound. */
  chart?: { read: jest.Mock };
}

/** 20 closed 15m bars trending up from 9500 and 6 closed 5m bars with volume, ending 21:15 IST. */
const chartData = () => {
  const end = ist('21:15:00').getTime();
  const bars15 = Array.from({ length: 20 }, (_, i) => {
    const c = 9500 + i * 3;
    return { ts: end - (20 - i) * 15 * 60_000, open: c - 2, high: c + 4, low: c - 4, close: c, volume: null };
  });
  const bars5 = Array.from({ length: 6 }, (_, i) => {
    const c = 9550 + i;
    return { ts: end - (6 - i) * 5 * 60_000, open: c, high: c + 2, low: c - 2, close: c, volume: 100 };
  });
  return { ref: { exchange: 'MCX', token: '1', symbol: 'CRUDEOILM19NOVFUT' }, bars5, bars15, n15: 8 };
};

function makeSvc(o: Opts = {}) {
  const build = jest.fn().mockResolvedValue(o.entries ?? [entry()]);
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  const buildPacket = jest.fn().mockImplementation((_e, t) =>
    Promise.resolve({ position: { entryPrice: t.entryPrice }, money: { netPnl: 1, greenFloorPrice: t.noiseFloor?.level ?? null, greenFloorArmed: !!t.noiseFloor?.armed } }));
  const judge = jest.fn().mockResolvedValue({
    verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true, reason: 'the alarm is noise on the 15m',
    evidence: ['alarm.reason'], invalidationPoint: 'x', reviewIn: 90,
  });
  const record = jest.fn().mockResolvedValue({ id: 'v-new' });
  const recentForTracker = jest.fn().mockResolvedValue(o.recent ?? []);
  const tickFor = jest.fn();
  const raise = jest.fn(async (a: RaiseAlarm, _now?: Date) => ({ id: 'al-1', ...a }) as unknown as AlarmRow);
  const openForTrackers = jest.fn(async () => o.open ?? []);
  const alarms = { raise, openForTrackers, openFor: jest.fn(), answer: jest.fn() };
  const authority = { isLive: jest.fn(() => o.live !== false) };
  const briefFor = jest.fn(async () => (o.brief === undefined ? 'plan: ride the breakdown to 9480' : o.brief));
  const ports = o.ports !== false;
  const svc = new SentinelCycleService(
    { build } as never, { evaluate } as never, { build: buildPacket } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'SHORT', reason: 'long put', levelPrice: 9560, targetPrice: 9480, invalidation: 9650, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v9/t1' } as never, { record, recentForTracker } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never, { tickFor } as never,
    undefined, o.discipline, undefined, undefined, undefined, undefined, undefined, undefined, o.gate, undefined, o.reader ?? undefined, undefined, undefined,
    ports ? (alarms as never) : undefined, ports ? (authority as never) : undefined, ports ? ({ briefFor, write: jest.fn() } as never) : undefined,
    (o.chart as never) ?? undefined,
  );
  const pass = async (hms: string, t: TickReading) => {
    tickFor.mockResolvedValueOnce(t);
    return svc.runForUser(USER, ist(hms));
  };
  return { svc, build, evaluate, buildPacket, judge, record, recentForTracker, tickFor, raise, openForTrackers, briefFor, authority, pass };
}

const exitRows = (record: jest.Mock) => record.mock.calls.map((c) => c[0]).filter((r) => r.verdict === 'EXIT_NOW');

const quiet = () => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
};

/** GREEN_TO_RED on the CRUDEOILM put: armed at 380.4, then red under the floor on two reads. */
async function greenToRed(t: ReturnType<typeof makeSvc>) {
  await t.pass('21:00:00', tick(380.4, 9531));
  const red = (ltp: number): TickReading => tick(ltp, 9545, 380.4, { noise: { ...noise, underlying1m: null } });
  await t.pass('21:20:00', red(364));
  await t.pass('21:20:30', red(363.8));
}

describe('exit authority — FLOOR (hardFloorFor → recordHardFloorExit)', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  it('live: raises a FLOOR alarm (normal) and writes NO EXIT_NOW; wouldHave carries the old reason', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}) });
    await greenToRed(t);
    expect(exitRows(t.record)).toHaveLength(0);
    expect(t.raise).toHaveBeenCalledTimes(1);
    const a = t.raise.mock.calls[0][0];
    expect(a).toMatchObject({ userId: USER, trackerId: 't-pe', symbol: SYMBOL, rule: 'FLOOR', urgency: 'normal' });
    expect(a.wouldHave).toContain('EXIT_NOW');
    expect(a.wouldHave).toContain(FLOOR_HARD_EXIT_REASON_PREFIX);
    expect(a.wouldHave).toContain('GREEN_TO_RED');
    expect(a.reason).toMatch(/^GREEN_TO_RED: premium 363.8 below the armed floor/);
    expect(a.payload).toMatchObject({ ruleDetail: 'GREEN_TO_RED', floor: expect.any(Number), netPnl: expect.any(Number) });
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('off (authority not live): exactly today — the rule EXIT_NOW, no alarm', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}), live: false });
    await greenToRed(t);
    const rows = exitRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptVersion: FLOOR_HARD_EXIT_STAMP });
    expect(t.raise).not.toHaveBeenCalled();
    expect(t.openForTrackers).not.toHaveBeenCalled();
  });

  it('ports absent (module without exit authority): exactly today', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}), ports: false });
    await greenToRed(t);
    expect(exitRows(t.record)).toHaveLength(1);
  });

  it('a paper tracker under live keeps today\'s rule', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}), entries: [entry({ trackerId: 'paper:tr1' })] });
    await greenToRed(t);
    expect(exitRows(t.record)).toHaveLength(1);
    expect(t.raise).not.toHaveBeenCalled();
  });

  it('a failed raise clears the fire, so the next confirming pass raises again (like a failed verdict write)', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}) });
    t.raise.mockRejectedValueOnce(new Error('db down'));
    await greenToRed(t);
    await t.pass('21:21:00', tick(363.5, 9546, 380.4, { noise: { ...noise, underlying1m: null } }));
    expect(t.raise).toHaveBeenCalledTimes(2);
    expect(exitRows(t.record)).toHaveLength(0);
  });
});

describe('exit authority — HARD_LOSS (hardLossFor) and HARD_LOSS_FAST (rescueHardLoss)', () => {
  const ENV = { ...process.env };
  const NIFTY = 'NIFTY09NOV2623750PE';
  const nifty = (ltp: number): TickReading => ({
    ...tick(ltp, 23834.1, 159.55), entryPrice: 159.15, qty: 130, holdingHigh: 159.55, holdingLow: ltp, structureSymbol: 'NIFTY',
    expiry: '2026-11-09', entryUnderlying: 23812.25,
  });
  beforeEach(() => {
    quiet();
    process.env.HARD_LOSS_EXIT_RUPEES = '2000';
    process.env.HARD_LOSS_BY_TRADE_VALUE = 'off';
    process.env.HARD_LOSS_NOISE_N = '0';
    delete process.env.HARD_LOSS_CAP_RUPEES;
    delete process.env.HARD_LOSS_CEILING_BY_CLASS;
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });
  const niftyEntry = entry({ symbol: NIFTY, exchange: 'NFO', trackerId: 't-nifty' });

  it('live: a confirmed hard loss raises HARD_LOSS (urgent), no EXIT_NOW', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}), entries: [niftyEntry] });
    await t.pass('11:19:00', nifty(142.1));
    await t.pass('11:19:30', nifty(142.1));
    expect(exitRows(t.record)).toHaveLength(0);
    expect(t.raise).toHaveBeenCalledTimes(1);
    const a = t.raise.mock.calls[0][0];
    expect(a).toMatchObject({ rule: 'HARD_LOSS', urgency: 'urgent', trackerId: 't-nifty' });
    expect(a.wouldHave).toContain(`${FLOOR_HARD_EXIT_REASON_PREFIX} MAX_LOSS`);
    expect(a.payload).toMatchObject({ limit: 2000, netPnl: expect.any(Number) });
  });

  it('off: the same reads record the rule EXIT_NOW exactly as today', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}), entries: [niftyEntry], live: false });
    await t.pass('11:19:00', nifty(142.1));
    await t.pass('11:19:30', nifty(142.1));
    expect(exitRows(t.record)).toHaveLength(1);
    expect(exitRows(t.record)[0].reason).toMatch(/MAX_LOSS: net ₹-2\d{3} reached the hard loss exit of ₹2000/);
    expect(t.raise).not.toHaveBeenCalled();
  });

  const fast = async (live: boolean) => {
    const t = makeSvc({ entries: [niftyEntry], live });
    const ticks = (t.svc as unknown as { ticks: { quickPrice?: jest.Mock } }).ticks;
    ticks.quickPrice = jest.fn().mockResolvedValue({ segment: 'OPT', side: 'LONG', entryPrice: 159.15, qty: 130, ltp: 140, source: 'hub' });
    const rescue = (t.svc as unknown as { rescueHardLoss(e: RosterEntry, now: Date): Promise<void> }).rescueHardLoss.bind(t.svc);
    await rescue(niftyEntry, ist('11:19:00'));
    await rescue(niftyEntry, ist('11:19:30'));
    return t;
  };

  it('live: the fast guard raises HARD_LOSS_FAST (urgent) with payload.limit and payload.netPnl, no EXIT_NOW', async () => {
    const t = await fast(true);
    expect(exitRows(t.record)).toHaveLength(0);
    expect(t.raise).toHaveBeenCalledTimes(1);
    const a = t.raise.mock.calls[0][0];
    expect(a).toMatchObject({ rule: 'HARD_LOSS_FAST', urgency: 'urgent' });
    expect(a.payload).toMatchObject({ limit: 2000 });
    expect(typeof (a.payload as { netPnl: unknown }).netPnl).toBe('number');
    expect(a.wouldHave).toMatch(/fast guard/);
  });

  it('off: the fast guard records its EXIT_NOW as today', async () => {
    const t = await fast(false);
    expect(exitRows(t.record)).toHaveLength(1);
    expect(exitRows(t.record)[0]).toMatchObject({ promptVersion: FLOOR_HARD_EXIT_STAMP });
    expect(t.raise).not.toHaveBeenCalled();
  });
});

describe('exit authority — LADDER (ladderExitFor → recordLadderExit)', () => {
  const PLAN: LadderPlan = { targets: [120, 140], riskStop: 90, source: 'signal', detail: 'signal plan: T 120 / 140' };
  const ce = entry({ trackerId: 't-ce', symbol: 'NIFTY04NOV2625000CE', exchange: 'NFO' });
  const lt = (ltp: number, high: number): TickReading => ({ ...tick(ltp, 25010, high), entryPrice: 100, qty: 75, holdingLow: 98, expiry: '2026-11-04', noise: undefined });
  beforeEach(() => {
    quiet();
    process.env.PROFIT_LOCK_ARM_RUPEES = '0';
  });
  afterEach(() => {
    delete process.env.PROFIT_LOCK_ARM_RUPEES;
    jest.restoreAllMocks();
  });
  const run = async (live: boolean) => {
    const t = makeSvc({ entries: [ce], live, reader: { mode: 'on', planFor: jest.fn().mockResolvedValue(PLAN) } });
    await t.pass('10:00:00', lt(141, 141));
    await t.pass('10:00:30', lt(139, 141));
    return t;
  };

  it('live: the last target raises a LADDER alarm (normal), no EXIT_NOW', async () => {
    const t = await run(true);
    expect(exitRows(t.record)).toHaveLength(0);
    expect(t.raise).toHaveBeenCalledTimes(1);
    const a = t.raise.mock.calls[0][0];
    expect(a).toMatchObject({ rule: 'LADDER', urgency: 'normal', trackerId: 't-ce' });
    expect(a.wouldHave).toContain(TARGET_LADDER_REASON_PREFIX);
    expect(a.wouldHave).toContain('TARGET');
  });

  it('off: TARGET_LADDER EXIT_NOW exactly as today', async () => {
    const t = await run(false);
    const rows = exitRows(t.record);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptVersion).toBe(TARGET_LADDER_STAMP);
  });
});

describe('exit authority — the forced alarm look', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  const alarm = (over: Partial<AlarmRow> = {}): AlarmRow => ({
    id: 'al-7', userId: USER, trackerId: 't-pe', symbol: SYMBOL, rule: 'FLOOR', urgency: 'normal',
    reason: 'GREEN_TO_RED: premium 363.8 below the armed floor 376.8', wouldHave: 'EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED',
    deadline: null, severityN: null, sourceRef: null, payload: {}, status: 'OPEN',
    raisedAt: ist('21:19:50'), lastRaisedAt: ist('21:19:50'), answeredAt: null, answerVerdictId: null, answer: null,
    alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, ...over,
  });
  // The agent's last verdict: a HOLD 30 s before the alarm, inside the judge gate's 60 s re-judge gap.
  const lastHold = { verdict: 'HOLD', createdAt: ist('21:19:20'), promptVersion: 'v9/t1', reviewInSec: 900, packet: {} };

  it('an open alarm newer than the agent\'s last verdict is judged although no sensor woke it, past the gate, with alarm + brief in the packet', async () => {
    const t = makeSvc({ gate: parseJudgeGateConfig({}), open: [alarm()], recent: [lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.openForTrackers).toHaveBeenCalledTimes(1);
    expect(t.openForTrackers).toHaveBeenCalledWith(['t-pe']);
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.judge.mock.calls[0][1]).toBe('FIRE');
    const [, , , fires, review] = t.buildPacket.mock.calls[0];
    expect(fires).toEqual(expect.arrayContaining([expect.objectContaining({ name: ALARM_FIRE, kind: 'alarm', alarmId: 'al-7', rule: 'FLOOR' })]));
    expect(review.authority).toEqual({
      alarm: {
        rule: 'FLOOR', reason: alarm().reason, urgency: 'normal', deadline: null, raisedAt: ist('21:19:50').toISOString(),
        chart: { unavailable: 'no chart reader is bound in this process' },
      },
      brief: 'plan: ride the breakdown to 9480',
    });
    expect(t.record.mock.calls[0][0].triggeredBy).toContain(ALARM_FIRE);
  });

  it('live alarm look: alarm.chart is a fresh read — closes, VWAP, N15, the 15m Supertrend and readChart\'s verdict', async () => {
    const read = jest.fn().mockResolvedValue(chartData());
    const t = makeSvc({ open: [alarm()], recent: [lastHold], chart: { read } });
    await t.pass('21:20:00', tick(370, 9540));
    expect(read).toHaveBeenCalledWith('t-pe', ist('21:20:00'));
    const chart = t.buildPacket.mock.calls[0][4].authority.alarm.chart;
    expect(chart).toMatchObject({
      underlying: 'CRUDEOILM19NOVFUT',
      closes5: [9553, 9554, 9555],
      closes15: [9551, 9554, 9557],
      vwap: 9552.5,
      n15: 8,
      supertrend15: 'UP',
      known: true,
    });
    // A long PUT is bearish: an UP 15m Supertrend is against it, and the reasons say so.
    expect(chart.against).toBe(true);
    expect(chart.reasons.join(' ')).toMatch(/15m Supertrend is UP/);
  });

  it('the chart reader throws or returns nothing: alarm.chart is unavailable with why, the look still runs', async () => {
    for (const read of [jest.fn().mockRejectedValue(new Error('db down')), jest.fn().mockResolvedValue(null)]) {
      const t = makeSvc({ open: [alarm()], recent: [lastHold], chart: { read } });
      await t.pass('21:20:00', tick(370, 9540));
      expect(t.judge).toHaveBeenCalledTimes(1);
      const chart = t.buildPacket.mock.calls[0][4].authority.alarm.chart;
      expect(chart.unavailable).toEqual(expect.any(String));
    }
  });

  it('no alarm on the packet (live) or authority off: the chart is never read', async () => {
    const read = jest.fn().mockResolvedValue(chartData());
    const live = makeSvc({ open: [], recent: [lastHold], chart: { read } });
    live.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await live.pass('21:21:00', tick(370, 9540));
    expect(live.judge).toHaveBeenCalledTimes(1);
    const off = makeSvc({ open: [alarm()], recent: [lastHold], chart: { read }, live: false });
    off.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await off.pass('21:21:00', tick(370, 9540));
    expect(off.judge).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('raise() is given the cycle clock', async () => {
    const t = makeSvc({ discipline: parseExitDisciplineConfig({}) });
    await greenToRed(t);
    expect(t.raise.mock.calls[0][1]).toEqual(ist('21:20:30'));
  });

  it('two passes 5 s apart judge it once (TRACKER_WAKE_MIN_GAP_MS)', async () => {
    const t = makeSvc({ gate: parseJudgeGateConfig({}), open: [alarm()], recent: [lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    await t.pass('21:20:05', tick(370, 9540));
    expect(t.judge).toHaveBeenCalledTimes(1);
    await t.pass('21:20:25', tick(370, 9540)); // still unanswered (the fake store never sees the verdict) ⇒ again after the gap
    expect(t.judge).toHaveBeenCalledTimes(2);
  });

  it('an alarm the agent already answered (its verdict is newer) forces nothing; the packet still shows it', async () => {
    const t = makeSvc({ open: [alarm()], recent: [{ ...lastHold, createdAt: ist('21:19:55') }] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.judge).not.toHaveBeenCalled();
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('21:21:00', tick(370, 9540));
    expect(t.judge).toHaveBeenCalledTimes(1);
    const [, , , fires, review] = t.buildPacket.mock.calls[0];
    expect(fires.some((f: { name: string }) => f.name === ALARM_FIRE)).toBe(false);
    expect(review.authority.alarm).toMatchObject({ rule: 'FLOOR' });
  });

  it('a rule verdict does not count as the agent\'s answer', async () => {
    const ruleRow = { verdict: 'EXIT_NOW', createdAt: ist('21:19:58'), promptVersion: FLOOR_HARD_EXIT_STAMP, packet: {} };
    const t = makeSvc({ open: [alarm()], recent: [ruleRow, lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.judge).toHaveBeenCalledTimes(1);
  });

  it('a snoozed alarm (owner tapped Hold) forces nothing while the snooze runs', async () => {
    const t = makeSvc({ open: [alarm({ status: 'SNOOZED', snoozedUntil: ist('21:30:00') })], recent: [lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('a held position (AI_AUTO_EXIT_HOLD) is untouched', async () => {
    const t = makeSvc({ gate: parseJudgeGateConfig({ AI_AUTO_EXIT_HOLD: SYMBOL }), open: [alarm()], recent: [lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('no open alarm: unchanged — no forced look; live packets carry alarm null', async () => {
    const t = makeSvc({ open: [], recent: [lastHold] });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.judge).not.toHaveBeenCalled();
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('21:21:00', tick(370, 9540));
    expect(t.buildPacket.mock.calls[0][4].authority).toEqual({ alarm: null, brief: 'plan: ride the breakdown to 9480' });
  });

  it('off: no alarm read, no forced look, the packet build call is exactly as before (4 arguments)', async () => {
    const t = makeSvc({ open: [alarm()], recent: [lastHold], live: false });
    await t.pass('21:20:00', tick(370, 9540));
    expect(t.openForTrackers).not.toHaveBeenCalled();
    expect(t.judge).not.toHaveBeenCalled();
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('21:21:00', tick(370, 9540));
    expect(t.buildPacket.mock.calls[0]).toHaveLength(4);
    expect(t.briefFor).not.toHaveBeenCalled();
  });

  it('a failing alarm read is no forced look, never a failed pass', async () => {
    const t = makeSvc({ open: [alarm()], recent: [lastHold] });
    t.openForTrackers.mockRejectedValueOnce(new Error('db down'));
    const r = await t.pass('21:20:00', tick(370, 9540));
    expect(r.failed).toBe(0);
    expect(t.judge).not.toHaveBeenCalled();
  });
});
