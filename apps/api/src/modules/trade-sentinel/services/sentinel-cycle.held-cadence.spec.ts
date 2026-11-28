import { Logger } from '@nestjs/common';
import { RECENT_LOOK_WINDOW, SentinelCycleService, type TickReading } from './sentinel-cycle.service';
import type { RosterEntry } from './roster.service';
import { ADVISORY_VERDICT, LIVE_GAP_FIRE, parseJudgeGateConfig, type JudgeGateConfig } from './judge-gate';
import type { AlarmRow } from '../../exit-authority/exit-authority.tokens';
import { ALARM_FIRE } from './alarm-look';

/**
 * Supreme fixes W5 (2026-11-28):
 *  - a HELD position (AI_AUTO_EXIT_HOLD) is judged once per 60 min on the clock and its EXIT_NOW is stored as
 *    EXIT_ADVISORY (the executor polls EXIT_NOW only), with no exit trigger;
 *  - a LIVE position is looked at at least every 10 min while its venue is open (prod CRUDEOIL 2026-11-27: 19 min);
 *  - an authority DRILL alarm's look never writes an EXIT_NOW.
 */
const USER = 'u1';
const SYMBOL = 'CRUDEOIL16DEC268350CE';
const ist = (hms: string) => new Date(`2026-11-27T${hms}+05:30`);

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: USER, trackerId: 't-crude', symbol: SYMBOL, exchange: 'MCX', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
  reason: 'unowned position — sentinel claims it', ...over,
});

const tick = (ltp = 230, over: Partial<TickReading> = {}): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 239.1, qty: 100, ltp, underlyingLtp: 8002, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'CRUDEOIL', nearestSupport: 7900, nearestResistance: 8100,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: 240, holdingLow: 225,
  entryTime: new Date('2026-11-27T09:50:59.178Z'), expiry: '2026-12-16', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, noise: null, ...over,
});

const verdictOut = (over: Record<string, unknown> = {}) => ({
  verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true, reason: 'still inside the 15m range',
  evidence: ['x'], invalidationPoint: 'x', reviewIn: 300, ...over,
});

const EXIT = verdictOut({ verdict: 'EXIT_NOW', reason: 'the 15m broke the low' });
/** A HOLD that proposes a price trigger (stored on HOLD / EXIT_ARMED only): it would arm a price exit. */
const HOLD_TRIGGER = verdictOut({ exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 220 } });

/** The agent's last look (a sentinel judge stamp). */
const agentRow = (hms: string, over: Record<string, unknown> = {}) => ({
  verdict: 'HOLD', createdAt: ist(hms), promptVersion: 'v12+l1+d1+e1+s2+a2/t2', reviewInSec: 300,
  packet: { position: { ltp: 231.9, qty: 100 }, money: { greenFloorArmed: false } }, netPnl: -811, triggeredBy: ['heartbeat'], ...over,
});

interface Opts {
  gate?: JudgeGateConfig;
  entries?: RosterEntry[];
  recent?: unknown[];
  open?: AlarmRow[];
  live?: boolean;
  verdict?: Record<string, unknown>;
}

function makeSvc(o: Opts = {}) {
  const build = jest.fn().mockResolvedValue(o.entries ?? [entry()]);
  // The tripwire says "nothing due" unless a test says otherwise (prod 15:51–15:58: a flat 230 print).
  const evaluate = jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  const buildPacket = jest.fn().mockImplementation((_e, t) =>
    Promise.resolve({ position: { entryPrice: t.entryPrice, ltp: t.ltp, qty: t.qty }, money: { netPnl: -1000, greenFloorPrice: null, greenFloorArmed: false } }));
  const judge = jest.fn().mockResolvedValue(o.verdict ?? verdictOut());
  const record = jest.fn().mockResolvedValue({ id: 'v-new' });
  const recentForTracker = jest.fn().mockResolvedValue(o.recent ?? []);
  const tickFor = jest.fn();
  const alarms = { raise: jest.fn(), openForTrackers: jest.fn(async () => o.open ?? []), openFor: jest.fn(), answer: jest.fn() };
  const authority = { isLive: jest.fn(() => o.live !== false) };
  const svc = new SentinelCycleService(
    { build } as never, { evaluate } as never, { build: buildPacket } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'LONG', reason: 'long call', levelPrice: 7950, targetPrice: 8100, invalidation: 7900, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v12+l1+d1+e1+s2+a2/t2' } as never, { record, recentForTracker } as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never, { tickFor } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, o.gate ?? parseJudgeGateConfig({}), undefined, undefined, undefined, undefined,
    alarms as never, authority as never, { briefFor: jest.fn(async () => null), write: jest.fn() } as never,
  );
  const pass = async (hms: string, t: TickReading = tick()) => {
    tickFor.mockResolvedValueOnce(t);
    return svc.runForUser(USER, ist(hms));
  };
  return { svc, evaluate, judge, record, recentForTracker, pass };
}

const quiet = () => {
  for (const m of ['warn', 'log', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
};

describe('held position (AI_AUTO_EXIT_HOLD): once an hour, advisory only', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());
  const HELD = 'MAZDOCK29DEC261760PE';
  const heldEntry = entry({ trackerId: 't-maz', symbol: HELD, exchange: 'NFO' });
  const gate = parseJudgeGateConfig({ AI_AUTO_EXIT_HOLD: HELD });

  it('60 min after its last look: one look; its EXIT_NOW is written EXIT_ADVISORY, reason tagged, no exit trigger', async () => {
    const t = makeSvc({ gate, entries: [heldEntry], recent: [agentRow('10:16:00', { verdict: 'EXIT_NOW' })], verdict: EXIT });
    await t.pass('11:16:30');
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.judge.mock.calls[0][1]).toBe('HEARTBEAT');
    expect(t.record).toHaveBeenCalledTimes(1);
    const row = t.record.mock.calls[0][0];
    expect(row.verdict).toBe(ADVISORY_VERDICT);
    expect(row.reason).toBe('[advisory: owner hold (AI_AUTO_EXIT_HOLD)] the 15m broke the low');
    expect(row.exitTrigger).toBeUndefined();
  });

  it('30 min after its last look (the old cadence): nothing, even with a sensor firing', async () => {
    const t = makeSvc({ gate, entries: [heldEntry], recent: [agentRow('10:46:00', { verdict: 'EXIT_NOW' })], verdict: EXIT });
    t.evaluate.mockReturnValue({ fires: [{ name: 'giveback-off-peak', detail: 'x' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.pass('11:16:30');
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('a held HOLD verdict is written as it is, but never arms a price trigger', async () => {
    const t = makeSvc({ gate, entries: [heldEntry], recent: [agentRow('10:00:00')], verdict: HOLD_TRIGGER });
    await t.pass('11:16:30');
    expect(t.record.mock.calls[0][0]).toMatchObject({ verdict: 'HOLD', reason: 'still inside the 15m range' });
    expect(t.record.mock.calls[0][0].exitTrigger).toBeUndefined();
  });

  it('a NOT-held live position keeps its EXIT_NOW, and a HOLD keeps its exit trigger', async () => {
    const t = makeSvc({ recent: [agentRow('15:40:32')], verdict: EXIT });
    t.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await t.pass('15:56:00');
    expect(t.record.mock.calls[0][0]).toMatchObject({ verdict: 'EXIT_NOW', reason: 'the 15m broke the low' });
    const h = makeSvc({ recent: [agentRow('15:40:32')], verdict: HOLD_TRIGGER });
    h.evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
    await h.pass('15:56:00');
    expect(h.record.mock.calls[0][0].exitTrigger).toMatchObject({ instrument: 'PREMIUM', op: 'BELOW', price: 220 });
  });
});

describe('live max gap: a live position is looked at at least every 10 min while its venue is open', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  it('prod 2026-11-27 CRUDEOIL: last look 15:40:32, flat print, nothing due → looked at 15:50:32, not at 15:50:00', async () => {
    const t = makeSvc({ recent: [agentRow('15:40:32')] });
    await t.pass('15:50:00');
    expect(t.judge).not.toHaveBeenCalled();
    await t.pass('15:50:32');
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.judge.mock.calls[0][1]).toBe('HEARTBEAT');
    expect(t.record.mock.calls[0][0].triggeredBy).toEqual([LIVE_GAP_FIRE]);
  });

  it('past the 15-min rate cap too: the desk-manager row at 15:24 is not the agent\'s look', async () => {
    const desk = { verdict: 'HOLD', createdAt: ist('15:24:34'), promptVersion: 'desk-manager/1', reviewInSec: 0, packet: {}, netPnl: -620, triggeredBy: ['desk-manager'] };
    const t = makeSvc({ recent: [desk, agentRow('15:21:35')] });
    await t.pass('15:31:40');
    expect(t.judge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a paper position', { entries: [entry({ trackerId: 'paper:p1' })] }, '15:55:00'],
    ['the venue closed (MCX after 23:30)', {}, '23:45:00'],
    ['SENTINEL_LIVE_MAX_GAP_MIN=0', { gate: parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '0' }) }, '15:55:00'],
  ])('no live-gap look for %s', async (_n, over, hms) => {
    const t = makeSvc({ recent: [agentRow('15:40:32')], ...(over as Opts) });
    await t.pass(hms);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('a delivery holding never gets it', async () => {
    const t = makeSvc({ entries: [entry({ symbol: 'TCS', exchange: 'NSE', trackerId: 't-tcs' })], recent: [agentRow('11:00:00')] });
    await t.pass('11:30:00', tick(3000, { segment: 'EQ_DELIVERY', entryPrice: 3100, qty: 10 }));
    expect(t.judge).not.toHaveBeenCalled();
  });
});

describe('authority drill: the drill alarm\'s look never writes an EXIT_NOW', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());
  const alarm = (payload: Record<string, unknown>): AlarmRow => ({
    id: 'al-d', userId: USER, trackerId: 't-crude', symbol: SYMBOL, rule: 'FLOOR', urgency: 'normal',
    reason: 'DRILL: test alarm', wouldHave: 'DRILL (nothing is sold)', deadline: null, severityN: null, sourceRef: null, payload,
    status: 'OPEN', raisedAt: ist('15:45:00'), lastRaisedAt: ist('15:45:00'), answeredAt: null, answerVerdictId: null, answer: null,
    alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null,
  });

  it('drill alarm: forced look, EXIT_NOW stored EXIT_ADVISORY with no exit trigger', async () => {
    const t = makeSvc({ open: [alarm({ drill: true })], recent: [agentRow('15:44:00')], verdict: EXIT });
    await t.pass('15:45:30');
    expect(t.judge).toHaveBeenCalledTimes(1);
    const row = t.record.mock.calls[0][0];
    expect(row.triggeredBy).toContain(ALARM_FIRE);
    expect(row.verdict).toBe(ADVISORY_VERDICT);
    expect(row.reason).toMatch(/^\[advisory: authority drill\] /);
    expect(row.exitTrigger).toBeUndefined();
  });

  it('a drill look\'s HOLD never arms a price trigger (it would sell later)', async () => {
    const t = makeSvc({ open: [alarm({ drill: true })], recent: [agentRow('15:44:00')], verdict: HOLD_TRIGGER });
    await t.pass('15:45:30');
    expect(t.record.mock.calls[0][0]).toMatchObject({ verdict: 'HOLD' });
    expect(t.record.mock.calls[0][0].exitTrigger).toBeUndefined();
  });

  it('a real alarm open beside a drill alarm speaks for the trade: its look keeps EXIT_NOW', async () => {
    const real = { ...alarm({}), id: 'al-real', raisedAt: ist('15:44:30'), lastRaisedAt: ist('15:44:30') };
    const t = makeSvc({ open: [real, alarm({ drill: true })], recent: [agentRow('15:44:00')], verdict: EXIT });
    await t.pass('15:45:30');
    expect(t.record.mock.calls[0][0].verdict).toBe('EXIT_NOW');
  });

  it('a real alarm\'s look keeps EXIT_NOW (the authority path is unchanged)', async () => {
    const t = makeSvc({ open: [alarm({})], recent: [agentRow('15:44:00')], verdict: EXIT });
    await t.pass('15:45:30');
    expect(t.record.mock.calls[0][0].verdict).toBe('EXIT_NOW');
  });
});

describe('review round 1 (2026-11-28): drill looks only when the drill alarm is the only reason; non-agent rows never reset the clocks', () => {
  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());
  const drillAlarmRow = (over: Partial<AlarmRow> = {}): AlarmRow => ({
    id: 'al-d', userId: USER, trackerId: 't-crude', symbol: SYMBOL, rule: 'FLOOR', urgency: 'normal',
    reason: 'DRILL: test alarm', wouldHave: 'DRILL (nothing is sold)', deadline: null, severityN: null, sourceRef: null,
    payload: { drill: true }, status: 'OPEN', raisedAt: ist('15:45:00'), lastRaisedAt: ist('15:45:00'), answeredAt: null,
    answerVerdictId: null, answer: null, alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, ...over,
  });
  const desk = (hms: string) => ({
    verdict: 'HOLD', createdAt: ist(hms), promptVersion: 'desk-manager/1', reviewInSec: 0, packet: {}, netPnl: -620, triggeredBy: ['desk-manager'],
    exitTrigger: null,
  });

  it('a REAL fire merged into the drill alarm\'s look: a normal real look — EXIT_NOW stays EXIT_NOW, reason untagged', async () => {
    const t = makeSvc({ open: [drillAlarmRow()], recent: [agentRow('15:25:00')], verdict: EXIT, gate: parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '0' }) }); // past the 900 s cap: the fire reaches the look
    t.evaluate.mockReturnValue({ fires: [{ name: 'level-break', detail: 'broke 7950' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.pass('15:45:30');
    const row = t.record.mock.calls[0][0];
    expect(row.triggeredBy).toEqual(expect.arrayContaining([ALARM_FIRE, 'level-break']));
    expect(row).toMatchObject({ verdict: 'EXIT_NOW', reason: 'the 15m broke the low' });
  });

  it('a drill-only look tags every verdict\'s reason (a HOLD too), so it can never answer a real alarm', async () => {
    const t = makeSvc({ open: [drillAlarmRow()], recent: [agentRow('15:44:00')] });
    await t.pass('15:45:30');
    expect(t.record.mock.calls[0][0]).toMatchObject({ verdict: 'HOLD', reason: '[advisory: authority drill] still inside the 15m range' });
  });

  it('a drill look\'s row newer than a REAL alarm does not count as its answer: the forced look still runs', async () => {
    const real = { ...drillAlarmRow(), id: 'al-real', payload: {}, reason: 'GREEN_TO_RED', raisedAt: ist('15:45:00'), lastRaisedAt: ist('15:45:00') };
    const drillRow = agentRow('15:45:10', { reason: '[advisory: authority drill] still inside the 15m range' });
    const t = makeSvc({ open: [real], recent: [drillRow, agentRow('15:40:00')] });
    await t.pass('15:46:30');
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.record.mock.calls[0][0].triggeredBy).toContain(ALARM_FIRE);
  });

  it('the rate cap and the heartbeat clock measure from the AGENT\'s look: a newer desk-manager row resets neither', async () => {
    // Agent at 15:21:35, desk HOLD at 15:24:34 (prod CRUDEOIL 2026-11-27). A material fire at 15:37:00 is past the
    // 900 s cap from the agent's look (15:36:35) — before the fix the desk row capped it until 15:39:34.
    const t = makeSvc({ gate: parseJudgeGateConfig({ SENTINEL_LIVE_MAX_GAP_MIN: '0' }), recent: [desk('15:24:34'), agentRow('15:21:35')] });
    t.evaluate.mockReturnValue({ fires: [{ name: 'context-factor-flip', detail: 'x' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.pass('15:37:00');
    expect(t.judge).toHaveBeenCalledTimes(1);
    // The tripwire's heartbeat clock is handed the agent's look, not the desk row.
    expect(t.evaluate.mock.calls[0][1]).toEqual(ist('15:21:35'));
  });

  it('a held position\'s 60-min clock ignores a newer desk-manager row', async () => {
    const HELD = 'MAZDOCK29DEC261760PE';
    const t = makeSvc({
      gate: parseJudgeGateConfig({ AI_AUTO_EXIT_HOLD: HELD }),
      entries: [entry({ trackerId: 't-maz', symbol: HELD, exchange: 'NFO' })],
      recent: [desk('11:10:00'), agentRow('10:15:00')],
    });
    await t.pass('11:16:30');
    expect(t.judge).toHaveBeenCalledTimes(1);
  });

  it('the agent\'s row is found behind up to RECENT_LOOK_WINDOW−1 newer non-agent rows', async () => {
    const t = makeSvc({ recent: [...Array.from({ length: 9 }, (_, i) => desk(`15:3${i}:00`)), agentRow('15:29:00')] });
    await t.pass('15:39:30');
    expect(t.recentForTracker).toHaveBeenCalledWith('t-crude', RECENT_LOOK_WINDOW, { liveOnly: true });
    expect(t.judge).toHaveBeenCalledTimes(1); // the live gap from the agent's 15:29 look (the desk rows are not looks)
  });
});
