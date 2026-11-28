// apps/api/src/modules/sentinel-executor/services/exit-authority-router.service.spec.ts
import { Logger } from '@nestjs/common';
import { ExitAuthorityRouter, RAISE_ATTEMPTS, RULE_STAMPS, ruleAlarmFor } from './exit-authority-router.service';
import { FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP, isPaperTrackerId, isRuleStamp } from '../domain/exit-authority';
import { CARRY_EXIT_STAMP } from '../../intraday-carry/intraday-carry.service';
import { CONFIRM_TIMEOUT_MS } from '../../exit-authority/domain/timings';
import { isExitAnswer } from '../../exit-authority/domain/agent-verdict';
import type { AlarmRow, ConfirmResult } from '../../exit-authority/exit-authority.tokens';
import * as opsAlert from '../../../common/utils/ops-alert';

const T0 = new Date('2026-11-27T05:00:00Z');
const verdict = (over: Record<string, unknown> = {}) => ({
  id: 'v1', userId: 'owner', trackerId: 'trk1', symbol: 'NIFTY25NOV24000CE', reason: 'thesis broken', createdAt: T0,
  promptVersion: 'sentinel/v9', ...over,
});
const alarmRow = (over: Partial<AlarmRow> = {}): AlarmRow => ({
  id: 'al1', userId: 'owner', trackerId: 'trk1', symbol: 'NIFTY25NOV24000CE', rule: 'FLOOR', urgency: 'normal',
  reason: 'floor broke', wouldHave: 'EXIT_NOW FLOOR', status: 'OPEN', raisedAt: T0, lastRaisedAt: T0, answeredAt: null,
  answerVerdictId: null, answer: null, alertedAt: null, alertCount: 0, telegramMessageId: null, snoozedUntil: null, ...over,
});

function make(opts: { live?: boolean; confirm?: () => Promise<ConfirmResult>; open?: AlarmRow[]; noPorts?: boolean } = {}) {
  const repo = { claim: jest.fn().mockResolvedValue('row1'), update: jest.fn().mockResolvedValue(undefined) };
  const state = { isLive: jest.fn(() => opts.live ?? true) };
  const alarms = {
    raise: jest.fn().mockResolvedValue(alarmRow({ id: 'al-new' })),
    openFor: jest.fn().mockResolvedValue(opts.open ?? []),
    openForTrackers: jest.fn(),
    answer: jest.fn().mockResolvedValue(undefined),
  };
  const supreme = { confirm: jest.fn(opts.confirm ?? (async (): Promise<ConfirmResult> => ({ decision: 'CONFIRM', reason: 'agreed', latencyMs: 5 }))) };
  const briefs = { briefFor: jest.fn().mockResolvedValue('plan: ride to 24100'), write: jest.fn().mockResolvedValue(undefined) };
  const escalation = { blockedExit: jest.fn().mockResolvedValue(undefined) };
  const router = opts.noPorts
    ? new ExitAuthorityRouter(repo as never)
    : new ExitAuthorityRouter(repo as never, state, alarms, supreme, briefs, escalation);
  return { router, repo, state, alarms, supreme, briefs, escalation };
}
const flush = () => new Promise((r) => setImmediate(r));
let ops: jest.SpyInstance;

describe('ExitAuthorityRouter', () => {
  beforeEach(() => {
    ops = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('RULE_STAMPS are the rule stamps (wire contract with trade-sentinel + the imported carry stamp)', () => {
    expect(RULE_STAMPS).toEqual(['rule:floor-hard/1', 'rule:target-ladder/1', CARRY_EXIT_STAMP]);
    expect(CARRY_EXIT_STAMP).toBe('rule:intraday-carry/1');
    expect(RULE_STAMPS.every((s) => isRuleStamp(s))).toBe(true);
    expect(isRuleStamp('rule:some-future-rule/2')).toBe(true);
    expect(isRuleStamp('sentinel/v9')).toBe(false);
    expect(isRuleStamp(null)).toBe(false);
    expect(isPaperTrackerId('paper:abc')).toBe(true);
    expect(isPaperTrackerId('cm123')).toBe(false);
  });

  it('maps a stamp to its alarm rule (MAX_LOSS on the floor stamp = urgent hard loss)', () => {
    expect(ruleAlarmFor(FLOOR_HARD_EXIT_STAMP, 'FLOOR_HARD_EXIT (code rule, not a judgement) MAX_LOSS: net ₹-2100')).toEqual({ rule: 'HARD_LOSS', urgency: 'urgent' });
    expect(ruleAlarmFor(FLOOR_HARD_EXIT_STAMP, 'FLOOR_HARD_EXIT (code rule, not a judgement) GREEN_TO_RED: x')).toEqual({ rule: 'FLOOR', urgency: 'normal' });
    expect(ruleAlarmFor(TARGET_LADDER_STAMP, 'TARGET_LADDER …')).toEqual({ rule: 'LADDER', urgency: 'normal' });
    expect(ruleAlarmFor(CARRY_EXIT_STAMP, 'INTRADAY_CARRY EXIT …').rule).toBe('CARRY');
  });

  describe('off', () => {
    it.each([
      ['an LLM EXIT_NOW', verdict()],
      ['a rule EXIT_NOW', verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP })],
      ['a trigger verdict (no promptVersion)', verdict({ promptVersion: undefined })],
    ])('%s → EXECUTE, no port touched', async (_n, v) => {
      const { router, repo, alarms, supreme } = make({ live: false });
      expect(router.active()).toBe(false);
      await expect(router.route(v)).resolves.toEqual({ kind: 'EXECUTE' });
      expect(alarms.raise).not.toHaveBeenCalled();
      expect(alarms.openFor).not.toHaveBeenCalled();
      expect(supreme.confirm).not.toHaveBeenCalled();
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('no AUTHORITY_STATE bound → EXECUTE (inert)', async () => {
      const { router, repo } = make({ noPorts: true });
      expect(router.active()).toBe(false);
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'EXECUTE' });
      expect(repo.claim).not.toHaveBeenCalled();
    });
  });

  describe('live', () => {
    it.each([
      [FLOOR_HARD_EXIT_STAMP, 'FLOOR_HARD_EXIT (code rule, not a judgement) GREEN_TO_RED: broke', 'FLOOR'],
      [TARGET_LADDER_STAMP, 'TARGET_LADDER (code rule, not a judgement) T1 hit', 'LADDER'],
      [CARRY_EXIT_STAMP, 'INTRADAY_CARRY EXIT (close decision, code rule): EXPIRY_DAY', 'CARRY'],
    ])('a rule stamp %s → ALARM (no sale), the row claimed SKIPPED AUTHORITY_ALARM', async (stamp, reason, rule) => {
      const { router, repo, alarms, supreme } = make();
      const v = verdict({ promptVersion: stamp, reason });
      await expect(router.route(v, { mode: 'live', hold: [] })).resolves.toEqual({ kind: 'ALARM', alarmId: 'al-new' });
      expect(alarms.raise).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'owner', trackerId: 'trk1', symbol: v.symbol, rule, wouldHave: reason, sourceRef: 'v1',
      }));
      expect(repo.claim).toHaveBeenCalledWith(v, 'live');
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'AUTHORITY_ALARM' });
      expect(supreme.confirm).not.toHaveBeenCalled();
    });

    it('a rule alarm deduped by an open alarm still claims the row SKIPPED (alarmId null)', async () => {
      const { router, repo, alarms } = make();
      alarms.raise.mockResolvedValueOnce(null);
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'ALARM', alarmId: null });
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'AUTHORITY_ALARM' });
    });

    it('a raise that throws leaves the verdict unclaimed (retried next pass), never executes, and alerts once', async () => {
      const { router, repo, alarms } = make();
      alarms.raise.mockRejectedValueOnce(new Error('db down'));
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'ALARM', alarmId: null });
      expect(repo.claim).not.toHaveBeenCalled();
      expect(ops).toHaveBeenCalledWith('authority-raise:v1', expect.stringContaining('could not be stored'));
    });

    it(`a raise failing ${RAISE_ATTEMPTS} times claims the row SKIPPED AUTHORITY_ALARM_RAISE_FAILED and tells the owner (stops head-of-line blocking)`, async () => {
      const { router, repo, alarms, escalation } = make();
      alarms.raise.mockRejectedValue(new Error('db down'));
      const v = verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP });
      for (let i = 1; i < RAISE_ATTEMPTS; i++) {
        await expect(router.route(v)).resolves.toEqual({ kind: 'ALARM', alarmId: null });
        expect(repo.claim).not.toHaveBeenCalled();
      }
      await expect(router.route(v)).resolves.toEqual({ kind: 'ALARM', alarmId: null });
      await flush();
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'AUTHORITY_ALARM_RAISE_FAILED' });
      expect(escalation.blockedExit).toHaveBeenCalledWith(expect.objectContaining({ trackerId: 'trk1', symbol: v.symbol }));
      expect(ops.mock.calls.filter((c) => c[0] === 'authority-raise:v1')).toHaveLength(1);
      expect(ops).toHaveBeenCalledWith('authority-raise-failed:v1', expect.any(String));
    });

    it('live with NO alarm store: fail closed — ALARM, row SKIPPED AUTHORITY_NO_ALARM_STORE, owner alerted, never EXECUTE', async () => {
      const repo = { claim: jest.fn().mockResolvedValue('row1'), update: jest.fn() };
      const escalation = { blockedExit: jest.fn().mockResolvedValue(undefined) };
      const router = new ExitAuthorityRouter(repo as never, { isLive: () => true }, undefined, undefined, undefined, escalation);
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'ALARM', alarmId: null });
      await flush();
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'AUTHORITY_NO_ALARM_STORE' });
      expect(ops).toHaveBeenCalledWith('authority-no-store:v1', expect.any(String));
      expect(escalation.blockedExit).toHaveBeenCalledTimes(1);
    });

    it.each(['CONFIRM', 'ERROR'] as const)('an LLM EXIT_NOW → confirm(); %s → EXECUTE, the open alarm answered', async (decision) => {
      const open = [alarmRow({ id: 'al1' })];
      const { router, repo, supreme, alarms } = make({ open, confirm: async () => ({ decision, reason: 'x', latencyMs: 9 }) });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
      expect(supreme.confirm).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'owner', trackerId: 'trk1', agentDecision: 'EXIT', agentReason: 'thesis broken', brief: 'plan: ride to 24100', alarm: open[0],
      }));
      expect(alarms.answer).toHaveBeenCalledWith('al1', 'v1', `EXIT_NOW (supreme ${decision})`);
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('a confirm that throws → ERROR → EXECUTE', async () => {
      const { router } = make({ confirm: async () => { throw new Error('vertex 500'); } });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
    });

    it('confirm is raced against CONFIRM_TIMEOUT_MS: a never-resolving supreme → TIMEOUT at 30 s → EXECUTE, alarm answered', async () => {
      jest.useFakeTimers();
      const warn = Logger.prototype.warn as jest.Mock;
      const { router, alarms } = make({ open: [alarmRow({ id: 'al1' })], confirm: () => new Promise<ConfirmResult>(() => undefined) });
      let done: unknown = null;
      const p = router.route(verdict()).then((r) => { done = r; });
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
      expect(done).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toEqual({ kind: 'EXECUTE' });
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('TIMEOUT'))).toBe(true);
      expect(alarms.answer).toHaveBeenCalledWith('al1', 'v1', 'EXIT_NOW (supreme TIMEOUT)');
    });

    it('OVERRIDE_HOLD → HELD_BY_SUPREME: row SKIPPED SUPREME_HOLD:<reason>, open alarm answered, brief note written', async () => {
      const open = [alarmRow({ id: 'al1', rule: 'FLOOR' })];
      const { router, repo, alarms, briefs, supreme } = make({
        open,
        confirm: async () => ({ decision: 'OVERRIDE_HOLD', reason: 'VWAP reclaimed on 15m', briefNote: 'hold above 24010', latencyMs: 20 }),
      });
      await expect(router.route(verdict(), { mode: 'live', hold: [] })).resolves.toEqual({ kind: 'HELD_BY_SUPREME', reason: 'VWAP reclaimed on 15m' });
      expect(supreme.confirm).toHaveBeenCalledWith(expect.objectContaining({ alarm: open[0] }));
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'SUPREME_HOLD:VWAP reclaimed on 15m' });
      expect(alarms.answer).toHaveBeenCalledWith('al1', 'v1', expect.stringContaining('HOLD'));
      expect(briefs.write).toHaveBeenCalledWith('trk1', 'owner', 'hold above 24010', 'CONFIRM');
    });

    it('OVERRIDE_HOLD with no TRADE_BRIEFS bound still holds', async () => {
      const repo = { claim: jest.fn().mockResolvedValue('row1'), update: jest.fn() };
      const supreme = { confirm: jest.fn(async (): Promise<ConfirmResult> => ({ decision: 'OVERRIDE_HOLD', reason: 'r', briefNote: 'n', latencyMs: 1 })) };
      const router = new ExitAuthorityRouter(repo as never, { isLive: () => true }, undefined, supreme, undefined);
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'HELD_BY_SUPREME', reason: 'r' });
    });

    it('an LLM EXIT_NOW while a SUPREME_EXIT alarm is open → EXECUTE without confirm(), the alarm answered', async () => {
      const ask = alarmRow({ id: 'al-sx', rule: 'SUPREME_EXIT', reason: 'supreme asks EXIT: momentum gone' });
      const { router, supreme, alarms, repo } = make({ open: [ask] });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
      expect(supreme.confirm).not.toHaveBeenCalled();
      expect(alarms.answer).toHaveBeenCalledWith('al-sx', 'v1', 'EXIT_NOW (supreme asked)');
      // The answer is the verdict word the escalation runner reads as the agent AGREEING (no second confirm).
      expect(isExitAnswer(alarms.answer.mock.calls[0][2])).toBe(true);
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('a CARRY rule EXIT_NOW (the carry judge) while the deadline CARRY alarm is open → not re-raised (deadline kept), row SKIPPED', async () => {
      const deadline = new Date(T0.getTime() + 30 * 60_000);
      const carry = alarmRow({ id: 'al-carry', rule: 'CARRY', urgency: 'deadline', deadline });
      const { router, repo, alarms } = make({ open: [carry] });
      const v = verdict({ promptVersion: CARRY_EXIT_STAMP, reason: 'INTRADAY_CARRY EXIT (close decision, code rule): judge EXIT_NOW' });
      await expect(router.route(v, { mode: 'live', hold: [] })).resolves.toEqual({ kind: 'ALARM', alarmId: 'al-carry' });
      expect(alarms.raise).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'AUTHORITY_ALARM' });
    });

    it('a paper tracker → EXECUTE (today\'s rules)', async () => {
      const { router, alarms, supreme } = make();
      await expect(router.route(verdict({ trackerId: 'paper:t1', promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'EXECUTE' });
      await expect(router.route(verdict({ trackerId: 'paper:t1' }))).resolves.toEqual({ kind: 'EXECUTE' });
      expect(alarms.raise).not.toHaveBeenCalled();
      expect(supreme.confirm).not.toHaveBeenCalled();
    });

    it('a tracker on the owner hold list → EXECUTE (the executor skips it OWNER_HOLD, as today)', async () => {
      const { router, alarms } = make();
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }), { mode: 'live', hold: ['NIFTY25NOV24000CE'] }))
        .resolves.toEqual({ kind: 'EXECUTE' });
      expect(alarms.raise).not.toHaveBeenCalled();
    });

    it('no SUPREME_CONFIRM bound → an LLM EXIT executes', async () => {
      const repo = { claim: jest.fn(), update: jest.fn() };
      const router = new ExitAuthorityRouter(repo as never, { isLive: () => true });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
    });
  });
});

/** AUTHORITY DRILL (supreme fixes W5): a drill-tagged verdict is never executed; a drill alarm never steers a real exit. */
describe('ExitAuthorityRouter — authority drill', () => {
  beforeEach(() => {
    ops = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const drillAlarm = alarmRow({ id: 'al-drill', payload: { drill: true } });

  it('an EXIT_NOW whose reason carries the drill tag: SKIPPED DRILL, no supreme call, never EXECUTE, DRILL ops line', async () => {
    const { router, repo, supreme, alarms } = make({ open: [drillAlarm] });
    const out = await router.route(verdict({ reason: '[advisory: authority drill] the 15m broke the low' }), { mode: 'live', hold: [] });
    expect(out).toEqual({ kind: 'DRILL' });
    expect(repo.claim).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'DRILL' });
    expect(supreme.confirm).not.toHaveBeenCalled();
    expect(alarms.answer).not.toHaveBeenCalled();
    expect(ops.mock.calls.some((c) => /DRILL/.test(String(c[1])))).toBe(true);
  });

  it('a drill-tagged rule verdict too (never an alarm raise, never a sale)', async () => {
    const { router, alarms, repo } = make();
    const out = await router.route(verdict({ reason: '[advisory: authority drill] x', promptVersion: FLOOR_HARD_EXIT_STAMP }), { mode: 'live', hold: [] });
    expect(out).toEqual({ kind: 'DRILL' });
    expect(alarms.raise).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('row1', { status: 'SKIPPED', reason: 'DRILL' });
  });

  it('a REAL agent EXIT_NOW while only a drill alarm is open: confirmed as usual with no alarm context; the drill alarm is not answered by it', async () => {
    const { router, supreme, alarms } = make({ open: [drillAlarm] });
    const out = await router.route(verdict(), { mode: 'live', hold: [] });
    expect(out).toEqual({ kind: 'EXECUTE' });
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
    expect(supreme.confirm).toHaveBeenCalledWith(expect.objectContaining({ alarm: null }));
    expect(alarms.answer).not.toHaveBeenCalled();
  });

  it('a drill flag on a SUPREME_EXIT alarm never counts as the supreme asking', async () => {
    const { router, supreme } = make({ open: [alarmRow({ id: 'se', rule: 'SUPREME_EXIT', payload: { drill: true } })] });
    await router.route(verdict(), { mode: 'live', hold: [] });
    expect(supreme.confirm).toHaveBeenCalledTimes(1);
  });
});
