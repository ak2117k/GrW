// apps/api/src/modules/sentinel-executor/services/exit-authority-router.service.spec.ts
import { Logger } from '@nestjs/common';
import { ExitAuthorityRouter, RULE_STAMPS, ruleAlarmFor } from './exit-authority-router.service';
import { FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP, isPaperTrackerId, isRuleStamp } from '../domain/exit-authority';
import { CARRY_EXIT_STAMP } from '../../intraday-carry/intraday-carry.service';
import { CONFIRM_TIMEOUT_MS } from '../../exit-authority/domain/timings';
import type { AlarmRow, ConfirmResult } from '../../exit-authority/exit-authority.tokens';

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
  const router = opts.noPorts
    ? new ExitAuthorityRouter(repo as never)
    : new ExitAuthorityRouter(repo as never, state, alarms, supreme, briefs);
  return { router, repo, state, alarms, supreme, briefs };
}

describe('ExitAuthorityRouter', () => {
  beforeEach(() => {
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

    it('a raise that throws leaves the verdict unclaimed (retried next pass) and never executes', async () => {
      const { router, repo, alarms } = make();
      alarms.raise.mockRejectedValueOnce(new Error('db down'));
      await expect(router.route(verdict({ promptVersion: FLOOR_HARD_EXIT_STAMP }))).resolves.toEqual({ kind: 'ALARM', alarmId: null });
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it.each(['CONFIRM', 'ERROR'] as const)('an LLM EXIT_NOW → confirm(); %s → EXECUTE', async (decision) => {
      const { router, repo, supreme } = make({ confirm: async () => ({ decision, reason: 'x', latencyMs: 9 }) });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
      expect(supreme.confirm).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'owner', trackerId: 'trk1', agentDecision: 'EXIT', agentReason: 'thesis broken', brief: 'plan: ride to 24100', alarm: null,
      }));
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('a confirm that throws → ERROR → EXECUTE', async () => {
      const { router } = make({ confirm: async () => { throw new Error('vertex 500'); } });
      await expect(router.route(verdict())).resolves.toEqual({ kind: 'EXECUTE' });
    });

    it('confirm is raced against CONFIRM_TIMEOUT_MS: a never-resolving supreme → TIMEOUT at 30 s → EXECUTE', async () => {
      jest.useFakeTimers();
      const warn = Logger.prototype.warn as jest.Mock;
      const { router } = make({ confirm: () => new Promise<ConfirmResult>(() => undefined) });
      let done: unknown = null;
      const p = router.route(verdict()).then((r) => { done = r; });
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
      expect(done).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toEqual({ kind: 'EXECUTE' });
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('TIMEOUT'))).toBe(true);
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
      expect(alarms.answer).toHaveBeenCalledWith('al-sx', 'v1', expect.any(String));
      expect(repo.claim).not.toHaveBeenCalled();
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
