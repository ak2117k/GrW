/**
 * Trade agent exit authority — END TO END across modules (plan Task 7 step 3), in-memory fakes for the DB, the LLM,
 * the supreme and the broker. Real code on the path: SentinelCycleService (rule → alarm, forced look),
 * TradeAlarmsService (store, dedupe, wake), SentinelExitPoller + ExitAuthorityRouter (confirm, route),
 * SentinelExitExecutor.process (claim → execute 'AI'), EscalationRunner (escalation, backstop), the Task 2 failover
 * transport (all routes down ⇒ AI_HEALTH), SentinelCycleService.hardLossStillPast (HARD_LOSS_PROBE) and
 * ManualOwnerExit (OWNER_EXIT → ManualExitService.request).
 *
 *   1. floor rule trips → alarm → forced look → LLM fake EXIT_NOW → poller → supreme CONFIRM → execute(trigger 'AI')
 *   2. the same with supreme OVERRIDE_HOLD → no execute, alarm answered
 *   3. the LLM throws on every route for 10 min while past the hard loss and the owner is silent → backstop
 *      manual.request
 */
import { Logger } from '@nestjs/common';
import { aiHealthOf, failoverTransport } from '../ai-gateway/audit/failover-transport';
import type { MessagesTransport } from '../ai-gateway/transport.types';
import { parseExitDisciplineConfig } from '../exit-discipline/config';
import { parseAutoExitConfig } from '../sentinel-executor/domain/auto-exit.config';
import { ExitAuthorityRouter } from '../sentinel-executor/services/exit-authority-router.service';
import { ManualOwnerExit } from '../sentinel-executor/services/owner-exit.adapter';
import { SentinelExitExecutor } from '../sentinel-executor/services/sentinel-exit-executor.service';
import { SentinelExitPoller } from '../sentinel-executor/services/sentinel-exit-poller.service';
import type { RosterEntry } from '../trade-sentinel/services/roster.service';
import { SentinelCycleService, type TickReading } from '../trade-sentinel/services/sentinel-cycle.service';
import * as opsAlert from '../../common/utils/ops-alert';
import { isAgentVerdictStamp } from './domain/agent-verdict';
import { BACKSTOP_OWNER_SILENT_MS } from './domain/timings';
import type { AlarmRow, AlarmRule, ConfirmResult } from './exit-authority.tokens';
import type { AgentVerdictRef, TradeAlarmPatch } from './repositories/trade-alarm.repository';
import type { AuthorityStateService } from './services/authority-state.service';
import { EscalationRunner } from './services/escalation-runner.service';
import { TradeAlarmsService } from './services/trade-alarms.service';
import { TrackerMessages } from './telegram/tracker-messages';

const USER = 'u1';
const ist = (day: string, hms: string) => new Date(`${day}T${hms}+05:30`);

/** trade_alarms + sentinel_verdicts + trade_trackers + ai_exit_executions, in memory. */
class Db {
  alarms: AlarmRow[] = [];
  verdicts: Array<{ id: string; userId: string; trackerId: string; symbol: string; verdict: string; reason: string; promptVersion: string; createdAt: Date; reviewInSec?: number; packet?: unknown }> = [];
  open = new Set<string>();
  claimed = new Map<string, { verdictId: string; status: string; reason?: string }>();
  private seq = 0;

  // ── TradeAlarmRepository ──
  async create(input: Omit<AlarmRow, 'id'>): Promise<AlarmRow> {
    const row = { ...input, id: `al${++this.seq}` } as AlarmRow;
    this.alarms.push(row);
    return { ...row };
  }
  async findLatestLive(trackerId: string, rule: AlarmRule): Promise<AlarmRow | null> {
    const r = this.alarms
      .filter((a) => a.trackerId === trackerId && a.rule === rule && ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status))
      .sort((x, y) => y.lastRaisedAt.getTime() - x.lastRaisedAt.getTime())[0];
    return r ? { ...r } : null;
  }
  async findOpen(trackerId: string): Promise<AlarmRow[]> {
    return this.alarms.filter((a) => a.trackerId === trackerId && ['OPEN', 'SNOOZED'].includes(a.status)).map((a) => ({ ...a }));
  }
  async findOpenForTrackers(ids: string[]): Promise<AlarmRow[]> {
    return this.alarms.filter((a) => ids.includes(a.trackerId) && ['OPEN', 'SNOOZED'].includes(a.status)).map((a) => ({ ...a }));
  }
  async update(id: string, patch: TradeAlarmPatch): Promise<AlarmRow> {
    const r = this.alarms.find((a) => a.id === id);
    if (!r) throw new Error(`no alarm ${id}`);
    Object.assign(r, patch);
    return { ...r };
  }
  async answerIfOpen(id: string, patch: { answeredAt: Date; answerVerdictId: string; answer: string }): Promise<boolean> {
    const r = this.alarms.find((a) => a.id === id && ['OPEN', 'SNOOZED'].includes(a.status));
    if (!r) return false;
    Object.assign(r, { status: 'ANSWERED', ...patch });
    return true;
  }
  async latestAgentVerdict(trackerId: string, since: Date): Promise<AgentVerdictRef | null> {
    const v = this.verdicts
      .filter((x) => x.trackerId === trackerId && x.createdAt > since && isAgentVerdictStamp(x.promptVersion))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return v ? { id: v.id, verdict: v.verdict, createdAt: v.createdAt } : null;
  }
  // ── EscalationRepository ──
  async findForRunner(): Promise<AlarmRow[]> {
    return this.alarms.filter((a) => ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status)).map((a) => ({ ...a, payload: a.payload ? { ...a.payload } : undefined }));
  }
  async openTrackerIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((i) => this.open.has(i)));
  }
  async trackerMessageId(trackerId: string): Promise<number | null> {
    return this.alarms.find((a) => a.trackerId === trackerId && a.telegramMessageId != null)?.telegramMessageId ?? null;
  }
  async setTrackerMessageId(trackerId: string, id: number): Promise<void> {
    for (const a of this.alarms) if (a.trackerId === trackerId && ['OPEN', 'SNOOZED', 'ANSWERED'].includes(a.status)) a.telegramMessageId = id;
  }
  async executionForVerdict(verdictId: string): Promise<{ status: string; reason: string | null } | null> {
    const c = [...this.claimed.values()].find((x) => x.verdictId === verdictId);
    return c ? { status: c.status, reason: c.reason ?? null } : null;
  }
  async carryConverted(): Promise<boolean> {
    return false;
  }
  // ── sentinel_verdicts (the cycle's verdict repository) ──
  verdictStore(clock: () => Date) {
    return {
      record: jest.fn(async (r: Record<string, unknown>) => {
        const row = { ...(r as never as Db['verdicts'][number]), id: `v${++this.seq}`, createdAt: clock() };
        this.verdicts.push(row);
        return { id: row.id };
      }),
      recentForTracker: jest.fn(async (trackerId: string) =>
        this.verdicts.filter((v) => v.trackerId === trackerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
    };
  }
  // ── ai_exit_executions (poller + router + executor) ──
  execRepo() {
    return {
      pendingVerdicts: jest.fn(async () =>
        this.verdicts
          .filter((v) => v.verdict === 'EXIT_NOW' && ![...this.claimed.values()].some((c) => c.verdictId === v.id))
          .map((v) => ({ id: v.id, userId: v.userId, trackerId: v.trackerId, symbol: v.symbol, reason: v.reason, createdAt: v.createdAt, promptVersion: v.promptVersion }))),
      claim: jest.fn(async (v: { id: string }) => {
        if ([...this.claimed.values()].some((c) => c.verdictId === v.id)) return null;
        const id = `row-${v.id}`;
        this.claimed.set(id, { verdictId: v.id, status: 'CLAIMED' });
        return id;
      }),
      update: jest.fn(async (id: string, patch: { status: string; reason?: string }) => {
        Object.assign(this.claimed.get(id)!, patch);
      }),
      sweepInterrupted: jest.fn(async () => 0),
    };
  }
}

const noise = {
  contract: { n: 1.8, method: 'atr14-1m' as const, bars: 60, at: 'x' },
  underlying1m: { n: 12.5, method: 'atr14-1m' as const, bars: 60, at: 'x' },
  reason: null,
};

const baseTick = (ltp: number, underlying: number, high: number): TickReading => ({
  segment: 'OPT', side: 'LONG', entryPrice: 362.55, qty: 20, ltp, underlyingLtp: underlying, underlyingLtpAt: null,
  underlyingLtpSource: 'hub', underlyingLtpReason: null, structureSymbol: 'CRUDEOILM', nearestSupport: 9500, nearestResistance: 9620,
  structureReason: null, structureAt: null, structureSource: 'level book', holdingHigh: high, holdingLow: 362.55,
  entryTime: new Date('2026-10-29T14:40:00.000Z'), expiry: '2026-11-17', volumeRatio: null, freshNewsCount: null,
  factorValues: {}, factorsReason: null, noise,
});

type Judge = jest.Mock;

/** The live sentinel cycle wired to the REAL alarm service over the in-memory store; `judge` is the LLM fake. */
function sentinel(db: Db, entry: RosterEntry, judge: Judge, clock: { now: Date }) {
  const wake = { wakeTracker: jest.fn() };
  const state = { isLive: () => true };
  const alarms = new TradeAlarmsService(db as never, wake, state);
  const verdicts = db.verdictStore(() => clock.now);
  const tickFor = jest.fn();
  const quickPrice = jest.fn();
  const buildPacket = jest.fn().mockImplementation((_e, t) =>
    Promise.resolve({ position: { entryPrice: t.entryPrice }, money: { netPnl: -1, greenFloorPrice: t.noiseFloor?.level ?? null, greenFloorArmed: !!t.noiseFloor?.armed } }));
  const cycle = new SentinelCycleService(
    { build: jest.fn().mockResolvedValue([entry]) } as never,
    { evaluate: jest.fn().mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null }) } as never,
    { build: buildPacket } as never,
    { ensureFor: jest.fn().mockResolvedValue({ direction: 'SHORT', reason: 'long put', levelPrice: 9560, targetPrice: 9480, invalidation: 9650, source: 'INFERRED' }) } as never,
    { judge, promptVersion: 'v9/t1' } as never,
    verdicts as never,
    { captureAndCompare: jest.fn().mockResolvedValue({ now: null, prev: null }) } as never,
    { tickFor, quickPrice } as never,
    undefined, parseExitDisciplineConfig({}), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    alarms as never, state as never, { briefFor: jest.fn(async () => 'plan: ride the breakdown to 9480'), write: jest.fn() } as never,
    undefined,
  );
  const pass = async (at: Date, t: TickReading) => {
    clock.now = at;
    tickFor.mockResolvedValueOnce(t);
    return cycle.runForUser(entry.userId, at);
  };
  return { cycle, alarms, wake, verdicts, pass, quickPrice, buildPacket };
}

const quiet = () => {
  for (const m of ['warn', 'log', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true);
};

const EXIT_NOW = {
  verdict: 'EXIT_NOW', confidence: 'high', thesisStatus: 'BROKEN', recoveryAvailable: false,
  reason: 'alarm.chart: two 15m closes under the floor and VWAP — the breakdown failed, exit', evidence: ['alarm.chart'],
  invalidationPoint: null, reviewIn: 60,
};

describe('exit authority e2e — floor alarm → forced look → agent EXIT_NOW → supreme → executor', () => {
  const ENV = { ...process.env };
  const DAY = '2026-10-29';
  const entry: RosterEntry = {
    userId: USER, trackerId: 't-pe', symbol: 'CRUDEOILM17NOV269350PE', exchange: 'MCX', kind: 'POSITION', ownership: 'SENTINEL',
    watched: true, reason: 'unowned position — sentinel claims it',
  };
  const red = (ltp: number): TickReading => ({ ...baseTick(ltp, 9545, 380.4), noise: { ...noise, underlying1m: null } });

  beforeEach(quiet);
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  async function run(decision: ConfirmResult['decision']) {
    const db = new Db();
    db.open.add('t-pe');
    const clock = { now: ist(DAY, '21:00:00') };
    const judge = jest.fn().mockResolvedValue(EXIT_NOW);
    const s = sentinel(db, entry, judge, clock);

    // 1. The floor rule trips (GREEN_TO_RED, confirmed over two reads): an alarm, no EXIT_NOW, the agent is woken.
    await s.pass(ist(DAY, '21:00:00'), baseTick(380.4, 9531, 380.4));
    await s.pass(ist(DAY, '21:20:00'), red(364));
    await s.pass(ist(DAY, '21:20:30'), red(363.8));
    expect(db.alarms).toHaveLength(1);
    expect(db.alarms[0]).toMatchObject({ rule: 'FLOOR', status: 'OPEN', trackerId: 't-pe' });
    expect(db.verdicts.filter((v) => v.verdict === 'EXIT_NOW')).toHaveLength(0);
    expect(s.wake.wakeTracker).toHaveBeenCalledWith(USER, 't-pe', 'alarm FLOOR');
    expect(judge).not.toHaveBeenCalled();

    // 2. The next pass owes the agent a forced look: the LLM fake answers EXIT_NOW (an LLM verdict, not a rule row).
    await s.pass(ist(DAY, '21:21:00'), red(363.5));
    expect(judge).toHaveBeenCalledTimes(1);
    const exits = db.verdicts.filter((v) => v.verdict === 'EXIT_NOW');
    expect(exits).toHaveLength(1);
    expect(exits[0].promptVersion.startsWith('rule:')).toBe(false);
    expect(db.alarms).toHaveLength(1); // the floor rule re-firing was deduped, not a second alarm

    // 3. The poller routes it: the supreme confirm, then the executor (trigger 'AI') — or nothing on OVERRIDE_HOLD.
    process.env.AI_AUTO_EXIT_ENABLED = 'true';
    process.env.AI_AUTO_EXIT_USER_IDS = USER;
    const repo = db.execRepo();
    const supreme = { confirm: jest.fn(async (): Promise<ConfirmResult> => ({ decision, reason: `supreme ${decision}`, latencyMs: 4, briefNote: decision === 'OVERRIDE_HOLD' ? 'hold to 9480' : null })) };
    const briefs = { briefFor: jest.fn(async () => 'plan: ride the breakdown to 9480'), write: jest.fn(async () => undefined) };
    const router = new ExitAuthorityRouter(repo as never, { isLive: () => true }, s.alarms, supreme, briefs, { blockedExit: jest.fn() });
    const execute = jest.fn(async () => ({ status: 'FILLED' }));
    const executor = { repo, execute } as unknown as SentinelExitExecutor;
    executor.process = SentinelExitExecutor.prototype.process.bind(executor);
    const poller = new SentinelExitPoller(repo as never, executor, {} as never, {} as never, undefined, undefined, router);
    (poller as unknown as { cfg: unknown }).cfg = parseAutoExitConfig(process.env);
    await poller.runOnce(ist(DAY, '21:21:05'));
    return { db, supreme, execute, briefs, exitId: exits[0].id };
  }

  it('supreme CONFIRM → the executor receives execute(…, trigger AI) for the agent\'s verdict; the alarm is answered', async () => {
    const { db, supreme, execute, exitId } = await run('CONFIRM');
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
    expect((supreme.confirm.mock.calls[0] as unknown[])[0]).toMatchObject({ userId: USER, trackerId: 't-pe', agentDecision: 'EXIT' });
    expect(execute).toHaveBeenCalledTimes(1);
    const [rowId, v, , , trigger] = execute.mock.calls[0] as unknown as [string, { id: string }, unknown, unknown, string];
    expect(trigger).toBe('AI');
    expect(v.id).toBe(exitId);
    expect(rowId).toBe(`row-${exitId}`);
    expect(db.alarms[0].status).toBe('ANSWERED');
    expect(db.alarms[0].answerVerdictId).toBe(exitId);
  });

  it('supreme OVERRIDE_HOLD → no execute; the row is SKIPPED SUPREME_HOLD, the alarm answered, the brief noted', async () => {
    const { db, supreme, execute, briefs, exitId } = await run('OVERRIDE_HOLD');
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(db.claimed.get(`row-${exitId}`)).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/^SUPREME_HOLD:/) });
    expect(db.alarms[0].status).toBe('ANSWERED');
    expect(briefs.write).toHaveBeenCalledWith('t-pe', USER, 'hold to 9480', 'CONFIRM');
  });
});

describe('exit authority e2e — every AI route down 10 min, past the hard loss, owner silent → backstop manual.request', () => {
  const ENV = { ...process.env };
  const DAY = '2026-11-09';
  const NIFTY = 'NIFTY09NOV2623750PE';
  const entry: RosterEntry = {
    userId: USER, trackerId: 't-nifty', symbol: NIFTY, exchange: 'NFO', kind: 'POSITION', ownership: 'SENTINEL', watched: true,
    reason: 'unowned position — sentinel claims it',
  };
  const nifty = (ltp: number): TickReading => ({
    ...baseTick(ltp, 23834.1, 159.55), entryPrice: 159.15, qty: 130, holdingHigh: 159.55, holdingLow: ltp, structureSymbol: 'NIFTY',
    expiry: '2026-11-09', entryUnderlying: 23812.25,
  });

  beforeEach(() => {
    quiet();
    process.env.HARD_LOSS_EXIT_RUPEES = '2000';
    process.env.HARD_LOSS_BY_TRADE_VALUE = 'off';
    process.env.HARD_LOSS_NOISE_N = '0';
    delete process.env.HARD_LOSS_CAP_RUPEES;
    delete process.env.HARD_LOSS_CEILING_BY_CLASS;
    process.env.AI_AUTO_EXIT_ENABLED = 'true';
    process.env.AI_AUTO_EXIT_USER_IDS = USER;
    // Backstops honour the executor's mode (dry-run rehearses, never sells): this account is live.
    process.env.AI_AUTO_EXIT_MODE = 'live';
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  it('the urgent HARD_LOSS alarm escalates at once (AI down), and 10 min of owner silence later the backstop sells via ManualExitService.request', async () => {
    const db = new Db();
    db.open.add('t-nifty');
    const clock = { now: ist(DAY, '11:19:00') };

    // The LLM: every route throws (the Task 2 failover transport over two dead routes). The agent's judge calls it.
    const dead = (name: string): MessagesTransport => ({ messages: { create: jest.fn(async () => { throw new Error(`${name} 503`); }) } }) as never;
    const llm = failoverTransport([{ name: 'vertex', transport: dead('vertex') }, { name: 'cli', transport: dead('cli') }], { clock: () => clock.now.getTime() });
    const judge = jest.fn(async () => {
      await llm.messages.create({ model: 'x', max_tokens: 10, messages: [] } as never);
      return EXIT_NOW;
    });
    const s = sentinel(db, entry, judge, clock);
    s.quickPrice.mockResolvedValue({ segment: 'OPT', side: 'LONG', entryPrice: 159.15, qty: 130, ltp: 142.1, source: 'hub' });

    // The hard loss (−₹2,000) confirms over two reads → an urgent HARD_LOSS alarm; then forced looks fail every pass.
    await s.pass(ist(DAY, '11:19:00'), nifty(142.1));
    await s.pass(ist(DAY, '11:19:30'), nifty(142.1));
    expect(db.alarms).toHaveLength(1);
    expect(db.alarms[0]).toMatchObject({ rule: 'HARD_LOSS', urgency: 'urgent', status: 'OPEN' });
    for (const hms of ['11:20:00', '11:20:30', '11:21:00']) await s.pass(ist(DAY, hms), nifty(142.1));
    expect(judge).toHaveBeenCalled();
    expect(db.verdicts.filter((v) => !v.promptVersion.startsWith('rule:'))).toHaveLength(0); // the agent never answered
    expect(aiHealthOf(llm).allDownSince()).not.toBeNull();

    // The runner: Telegram (fake) ALERT, then — owner silent, AI down, still past the limit — the backstop.
    const telegram = { sendMessage: jest.fn(async () => 501), editMessage: jest.fn(async () => undefined), deleteMessage: jest.fn(async () => undefined) };
    const manual = { request: jest.fn(async () => ({ row: { verdictId: 'man_t-nifty_1' }, started: true, done: Promise.resolve(null) })) };
    const runner = new EscalationRunner(
      db as never, db as never, s.alarms, { isLive: () => true } as unknown as AuthorityStateService, telegram as never, new TrackerMessages(),
      new ManualOwnerExit(manual as never),
      { stillPastLimit: (id: string) => s.cycle.hardLossStillPast(id) },
      aiHealthOf(llm),
      { confirm: jest.fn() },
      undefined,
      db as never, // EXIT_EXECUTION_READER
    );
    const alertAt = ist(DAY, '11:21:15');
    clock.now = alertAt;
    await runner.pass(alertAt);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.alarms[0].alertedAt).toEqual(alertAt);
    expect(manual.request).not.toHaveBeenCalled();

    const justBefore = new Date(alertAt.getTime() + BACKSTOP_OWNER_SILENT_MS - 1_000);
    clock.now = justBefore;
    await runner.pass(justBefore);
    expect(manual.request).not.toHaveBeenCalled();

    const due = new Date(alertAt.getTime() + BACKSTOP_OWNER_SILENT_MS);
    clock.now = due;
    await runner.pass(due);
    expect(manual.request).toHaveBeenCalledTimes(1);
    const [user, trackerId, opts] = manual.request.mock.calls[0] as unknown as [{ userId: string; role: string; email: string }, string, { reason: string }];
    expect(user).toEqual({ userId: USER, role: 'ADMIN', email: 'exit-authority@grw' });
    expect(trackerId).toBe('t-nifty');
    expect(opts.reason).toMatch(/^BACKSTOP HARD_LOSS: /);
    expect(db.alarms[0].status).toBe('BACKSTOPPED');
  });
});

describe('exit authority seam — SUPREME_EXIT: the router answers, the runner reads it as agreement and follows the agent\'s exit', () => {
  const T = new Date('2026-11-27T06:00:00Z');
  const sec = (s: number) => new Date(T.getTime() + s * 1000);

  beforeEach(quiet);
  afterEach(() => jest.restoreAllMocks());

  async function seam() {
    const db = new Db();
    db.open.add('t1');
    const state = { isLive: () => true };
    const alarms = new TradeAlarmsService(db as never, { wakeTracker: jest.fn() }, state);
    // The desk manager's EXIT became a SUPREME_EXIT alarm (Task 5); the agent then answered EXIT_NOW.
    const ask = await alarms.raise({
      userId: USER, trackerId: 't1', symbol: 'NIFTY25DEC26000CE', rule: 'SUPREME_EXIT', urgency: 'normal',
      reason: 'supreme asks EXIT: sector rolling over', wouldHave: 'MANUAL EXIT (desk manager → manual exit)',
    }, T);
    db.verdicts.push({ id: 'v-agent', userId: USER, trackerId: 't1', symbol: 'NIFTY25DEC26000CE', verdict: 'EXIT_NOW', reason: 'agree', promptVersion: 'v9+x1/t2', createdAt: sec(20) });
    const repo = db.execRepo();
    const routerConfirm = { confirm: jest.fn() };
    const router = new ExitAuthorityRouter(repo as never, state, alarms, routerConfirm, undefined, { blockedExit: jest.fn() });
    const routed = await router.route({ id: 'v-agent', userId: USER, trackerId: 't1', symbol: 'NIFTY25DEC26000CE', reason: 'agree', createdAt: sec(20), promptVersion: 'v9+x1/t2' }, { mode: 'live', hold: [] });

    const telegram = { sendMessage: jest.fn(async () => 7), editMessage: jest.fn(async () => undefined), deleteMessage: jest.fn(async () => undefined) };
    const ownerExit = { exitAsOwner: jest.fn(async (..._args: unknown[]) => 'man_t1_1') };
    const runnerConfirm = { confirm: jest.fn() };
    const runner = new EscalationRunner(
      db as never, db as never, alarms, state as unknown as AuthorityStateService, telegram as never, new TrackerMessages(),
      ownerExit, undefined, undefined, runnerConfirm, undefined, db as never, // EXIT_EXECUTION_READER
    );
    return { db, ask: ask!, routed, routerConfirm, runner, runnerConfirm, ownerExit, telegram };
  }

  it('router EXECUTE + answer EXIT_NOW → runner: agreed — no second confirm, no owner exit while the executor works / after it fills', async () => {
    const { db, ask, routed, routerConfirm, runner, runnerConfirm, ownerExit } = await seam();
    expect(routed).toEqual({ kind: 'EXECUTE' });
    expect(routerConfirm.confirm).not.toHaveBeenCalled();
    expect(db.alarms.find((a) => a.id === ask.id)).toMatchObject({ status: 'ANSWERED', answer: 'EXIT_NOW (supreme asked)', answerVerdictId: 'v-agent' });

    db.claimed.set('row-v-agent', { verdictId: 'v-agent', status: 'CLAIMED' });
    await runner.pass(sec(25));
    await runner.pass(sec(200));
    expect(runnerConfirm.confirm).not.toHaveBeenCalled();
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();

    db.claimed.get('row-v-agent')!.status = 'FILLED';
    await runner.pass(sec(215));
    db.open.delete('t1');
    await runner.pass(sec(230));
    expect(runnerConfirm.confirm).not.toHaveBeenCalled();
    expect(ownerExit.exitAsOwner).not.toHaveBeenCalled();
    expect(db.alarms.find((a) => a.id === ask.id)?.status).toBe('CLOSED');
  });

  it('the executor skips the agent\'s exit (e.g. user not on the AI allow-list) → the runner exits for the supreme via the owner path, not cancelling owner orders', async () => {
    const { db, runner, runnerConfirm, ownerExit, telegram } = await seam();
    db.claimed.set('row-v-agent', { verdictId: 'v-agent', status: 'SKIPPED', reason: 'USER_NOT_ENABLED' });
    await runner.pass(sec(25));
    expect(runnerConfirm.confirm).not.toHaveBeenCalled();
    expect(ownerExit.exitAsOwner).toHaveBeenCalledTimes(1);
    expect(ownerExit.exitAsOwner.mock.calls[0]).toEqual([USER, 't1', expect.stringMatching(/^SUPREME_EXIT \(agent agreed, its exit not sent\)/), { ownerInitiated: false }]);
    expect(telegram.sendMessage.mock.calls.map((c) => String((c as unknown[])[0])).join('\n')).toMatch(/USER_NOT_ENABLED/);
  });
});
