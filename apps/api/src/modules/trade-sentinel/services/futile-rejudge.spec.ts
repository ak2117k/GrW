import {
  NEW_RISK_FIRES,
  exitBlocked,
  isBlockingAttempt,
  isHeldPosition,
  parseFutileRejudgeConfig,
  suppressFutileJudgements,
  type ExitAttempt,
} from './futile-rejudge';
import type { TripwireResult } from './tripwire.service';

const NOW = Date.parse('2026-10-19T06:00:00.000Z');
const cfg = parseFutileRejudgeConfig({});
const fireDecision = (...names: string[]): TripwireResult => ({
  fires: names.map((name) => ({ name, detail: name })),
  heartbeat: false,
  shouldEvaluate: true,
  trigger: 'FIRE',
});
const CONFIRM = { name: 'exit-confirm', detail: 'last verdict EXIT_NOW' };
const attempt = (over: Partial<ExitAttempt> = {}): ExitAttempt => ({
  id: 'x1', trackerId: 't1', status: 'FAILED', reason: 'BROKER_AUTH', createdAt: new Date(NOW - 60_000), ...over,
});

describe('parseFutileRejudgeConfig', () => {
  it('defaults: on, 15 min cooldown, nothing held', () => {
    expect(cfg).toEqual({ enabled: true, cooldownMs: 15 * 60_000, hold: [] });
  });
  it('rollback with SENTINEL_FUTILE_REJUDGE_SUPPRESSION=false; bad cooldown falls back', () => {
    const c = parseFutileRejudgeConfig({ SENTINEL_FUTILE_REJUDGE_SUPPRESSION: ' FALSE ', SENTINEL_FUTILE_REJUDGE_COOLDOWN_MIN: '-3' });
    expect(c.enabled).toBe(false);
    expect(c.cooldownMs).toBe(15 * 60_000);
    expect(parseFutileRejudgeConfig({ SENTINEL_FUTILE_REJUDGE_COOLDOWN_MIN: '7' }).cooldownMs).toBe(7 * 60_000);
  });
  it('parses AI_AUTO_EXIT_HOLD exactly as the executor does (trim, upper-case, dedupe)', () => {
    expect(parseFutileRejudgeConfig({ AI_AUTO_EXIT_HOLD: ' nifty24oct ,NIFTY24OCT,, abc-id ' }).hold).toEqual(['NIFTY24OCT', 'ABC-ID']);
  });
});

describe('isHeldPosition', () => {
  it('matches by symbol or tracker id, case-insensitively', () => {
    expect(isHeldPosition(['NIFTY'], { trackerId: 't1', symbol: 'nifty' })).toBe(true);
    expect(isHeldPosition(['T1'], { trackerId: 't1', symbol: 'X' })).toBe(true);
    expect(isHeldPosition(['BANKNIFTY'], { trackerId: 't1', symbol: 'NIFTY' })).toBe(false);
    expect(isHeldPosition([], { trackerId: 't1', symbol: 'NIFTY' })).toBe(false);
  });
});

describe('isBlockingAttempt', () => {
  it.each([
    ['FAILED', 'BROKER_AUTH', true],
    ['FAILED', 'BROKER_READ', true],
    ['SKIPPED', 'OWNER_HOLD', true],
    ['FAILED', 'BROKER_REJECT', false],
    ['FAILED', 'INTERRUPTED', false],
    ['SKIPPED', 'AWAITING_CONFIRMATION', false],
    ['SKIPPED', 'DISABLED', false],
    ['PLACED', null, false],
    ['FILLED', null, false],
  ])('%s %s ⇒ %s', (status, reason, expected) => {
    expect(isBlockingAttempt({ status, reason })).toBe(expected);
  });
});

describe('exitBlocked', () => {
  it('blocks within the cooldown and records the qty when the attempt is first seen', () => {
    const r = exitBlocked(attempt(), undefined, 100, NOW, cfg);
    expect(r).toEqual({ blocked: true, memo: { attemptId: 'x1', qty: 100 } });
  });
  it('lifts on a quantity change since the attempt was first seen, and stays lifted for that attempt', () => {
    const first = exitBlocked(attempt(), undefined, 100, NOW, cfg);
    const changed = exitBlocked(attempt(), first.memo, 50, NOW + 1000, cfg);
    expect(changed.blocked).toBe(false);
    expect(changed.memo).toEqual({ attemptId: 'x1', qty: 100 });
  });
  it('a NEW blocking attempt re-baselines the quantity', () => {
    const r = exitBlocked(attempt({ id: 'x2' }), { attemptId: 'x1', qty: 100 }, 50, NOW, cfg);
    expect(r).toEqual({ blocked: true, memo: { attemptId: 'x2', qty: 50 } });
  });
  it('lifts once the cooldown has passed, with no attempt, or on a non-blocking latest attempt', () => {
    expect(exitBlocked(attempt({ createdAt: new Date(NOW - 15 * 60_000) }), undefined, 100, NOW, cfg).blocked).toBe(false);
    expect(exitBlocked(undefined, { attemptId: 'x1', qty: 100 }, 100, NOW, cfg)).toEqual({ blocked: false, memo: undefined });
    expect(exitBlocked(attempt({ status: 'FILLED', reason: null }), undefined, 100, NOW, cfg).blocked).toBe(false);
  });
});

describe('suppressFutileJudgements', () => {
  const noHeartbeat = () => false;

  it('no cause, or the flag off ⇒ exactly today’s wake (with the exit-confirm re-look)', () => {
    const d = fireDecision('giveback-off-peak');
    for (const [cause, c] of [[null, cfg], ['held', parseFutileRejudgeConfig({ SENTINEL_FUTILE_REJUDGE_SUPPRESSION: 'false' })], ['held', undefined]] as const) {
      const r = suppressFutileJudgements(d, CONFIRM, cause, c, noHeartbeat);
      expect(r.suppressed).toEqual([]);
      expect(r.decision.fires.map((f) => f.name)).toEqual(['giveback-off-peak', 'exit-confirm']);
      expect(r.decision.trigger).toBe('FIRE');
    }
  });

  it.each(['held', 'exit-blocked'] as const)('%s ⇒ fires and the exit-confirm re-look dropped; skipped when no heartbeat is due', (cause) => {
    const r = suppressFutileJudgements(fireDecision('giveback-off-peak', 'volume-anomaly'), CONFIRM, cause, cfg, noHeartbeat);
    expect(r.suppressed).toEqual(['giveback-off-peak', 'volume-anomaly', 'exit-confirm']);
    expect(r.decision).toEqual({ fires: [], heartbeat: false, shouldEvaluate: false, trigger: null });
  });

  it('keeps the heartbeat at its normal cadence when it is due', () => {
    const due = jest.fn(() => true);
    const r = suppressFutileJudgements(fireDecision('context-factor-flip'), null, 'held', cfg, due);
    expect(due).toHaveBeenCalledTimes(1);
    expect(r.decision).toEqual({ fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' });
  });

  it('an exit-confirm-only wake is dropped too', () => {
    const quiet: TripwireResult = { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null };
    const r = suppressFutileJudgements(quiet, CONFIRM, 'exit-blocked', cfg, noHeartbeat);
    expect(r.suppressed).toEqual(['exit-confirm']);
    expect(r.decision.shouldEvaluate).toBe(false);
  });

  it('a heartbeat-only wake is untouched and the heartbeat check is not re-run', () => {
    const hb: TripwireResult = { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' };
    const due = jest.fn(() => false);
    const r = suppressFutileJudgements(hb, null, 'held', cfg, due);
    expect(r.decision).toEqual(hb);
    expect(due).not.toHaveBeenCalled();
  });

  it.each([...NEW_RISK_FIRES])('a %s fire passes the WHOLE wake through, for either cause', (name) => {
    for (const cause of ['held', 'exit-blocked'] as const) {
      const r = suppressFutileJudgements(fireDecision('giveback-off-peak', name), CONFIRM, cause, cfg, noHeartbeat);
      expect(r.suppressed).toEqual([]);
      expect(r.decision.fires.map((f) => f.name)).toEqual(['giveback-off-peak', name, 'exit-confirm']);
    }
  });

  it('NEW_RISK_FIRES is exactly the four new-risk sensor families plus the deadline look', () => {
    expect([...NEW_RISK_FIRES].sort()).toEqual(['event-near', 'level-break', 'news-hit', 'oi-wall-shift', 'square-off-due']);
  });
});
