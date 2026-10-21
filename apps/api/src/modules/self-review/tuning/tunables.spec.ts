import { clampTunable, isAllowedTarget, isForbiddenTarget, TUNABLES, validateTunable } from './tunables';

describe('self-review allow-list', () => {
  it('lists exactly the contract targets', () => {
    expect(Object.keys(TUNABLES).sort()).toEqual([
      'exit.openingGuardMin',
      'exit.persistMinSec',
      'scorecard.factor.expiry.weight',
      'scorecard.factor.fii_dii.weight',
      'scorecard.factor.indicators.weight',
      'scorecard.factor.mood.weight',
      'scorecard.factor.news.requireConfirmation',
      'scorecard.factor.news.weight',
      'scorecard.factor.oi.weight',
      'scorecard.factor.vix.weight',
    ]);
    for (const t of Object.keys(TUNABLES)) expect(isForbiddenTarget(t)).toBe(false);
  });

  it.each([
    'risk.maxDailyLoss', 'maxPositionSize', 'killSwitch', 'exit.holdSwitch', 'AI_AUTO_EXIT_HOLD', 'exit.dailyExitCap',
    'autoExit.enabled', 'auto-exit.mode', 'broker.apiKey', 'credentials', 'scorecard.factor.oi.maxPoints',
  ])('rejects %s', (t) => {
    expect(isAllowedTarget(t)).toBe(false);
    expect(validateTunable(t, 1).ok).toBe(false);
  });

  it('enforces type and bounds without clamping', () => {
    expect(validateTunable('scorecard.factor.oi.weight', 1.5)).toEqual({ ok: true, value: 1.5 });
    expect(validateTunable('scorecard.factor.oi.weight', 1.6).ok).toBe(false);
    expect(validateTunable('scorecard.factor.oi.weight', -0.1).ok).toBe(false);
    expect(validateTunable('scorecard.factor.oi.weight', '1').ok).toBe(false);
    expect(validateTunable('scorecard.factor.news.requireConfirmation', true)).toEqual({ ok: true, value: true });
    expect(validateTunable('scorecard.factor.news.requireConfirmation', 1).ok).toBe(false);
    expect(validateTunable('exit.openingGuardMin', 31).ok).toBe(false);
    expect(validateTunable('exit.openingGuardMin', 7.5).ok).toBe(false);
    expect(validateTunable('exit.persistMinSec', 59).ok).toBe(false);
    expect(validateTunable('exit.persistMinSec', 600)).toEqual({ ok: true, value: 600 });
  });

  it('clamps arithmetic into bounds', () => {
    expect(clampTunable('scorecard.factor.oi.weight', 1.875)).toBe(1.5);
    expect(clampTunable('exit.openingGuardMin', 35)).toBe(30);
    expect(clampTunable('exit.persistMinSec', 900)).toBe(600);
    expect(clampTunable('exit.persistMinSec', 10)).toBe(60);
  });
});
