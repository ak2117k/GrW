import { clampTunable, isAllowedTarget, isForbiddenTarget, TUNABLES, validateTunable } from './tunables';

describe('self-review allow-list', () => {
  it('lists exactly the contract targets', () => {
    expect(Object.keys(TUNABLES).sort()).toEqual([
      'carry.decideByMin',
      'exit.floorArmN',
      'exit.floorTrailN',
      'exit.openingGuardMin',
      'exit.persistMinSec',
      'exit.spikeBankRiseN',
      'exit.spikeBankTrailN',
      'mbm.packet',
      'scorecard.factor.expiry.weight',
      'scorecard.factor.fii_dii.weight',
      'scorecard.factor.indicators.weight',
      'scorecard.factor.mood.weight',
      'scorecard.factor.news.requireConfirmation',
      'scorecard.factor.news.weight',
      'scorecard.factor.oi.weight',
      'scorecard.factor.vix.weight',
      'scorecard.stockMove.points',
      'signal.judgeDefaultTake',
      'signal.judgeMinConfidence',
    ]);
    for (const t of Object.keys(TUNABLES)) expect(isForbiddenTarget(t)).toBe(false);
  });

  it('scorecard.stockMove.points is 0 by default and only ever 0 or 1', () => {
    expect(TUNABLES['scorecard.stockMove.points']).toMatchObject({ default: 0, min: 0, max: 1, integer: true });
    expect(validateTunable('scorecard.stockMove.points', 1)).toEqual({ ok: true, value: 1 });
    expect(validateTunable('scorecard.stockMove.points', 0.5).ok).toBe(false);
    expect(validateTunable('scorecard.stockMove.points', 2).ok).toBe(false);
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

  it('the wrong-decision loop tunables: bounds, env-derived defaults', () => {
    expect(TUNABLES['signal.judgeMinConfidence']).toEqual({ kind: 'number', default: null, min: 50, max: 80, integer: true });
    expect(TUNABLES['signal.judgeDefaultTake']).toEqual({ kind: 'boolean', default: true });
    expect(TUNABLES['exit.floorArmN']).toMatchObject({ min: 1.0, max: 3.0, integer: false, default: null });
    expect(TUNABLES['exit.floorTrailN']).toMatchObject({ min: 1.0, max: 3.5, integer: false, default: null });
    expect(TUNABLES['exit.spikeBankRiseN']).toMatchObject({ min: 1.5, max: 4.0, integer: false, default: null });
    expect(TUNABLES['exit.spikeBankTrailN']).toMatchObject({ min: 0.5, max: 2.0, integer: false, default: null });
    expect(TUNABLES['carry.decideByMin']).toMatchObject({ min: 4, max: 9, integer: true, default: null });
    expect(validateTunable('signal.judgeMinConfidence', 49).ok).toBe(false);
    expect(validateTunable('signal.judgeMinConfidence', 62.5).ok).toBe(false);
    expect(validateTunable('exit.floorTrailN', 2.25)).toEqual({ ok: true, value: 2.25 });
    expect(validateTunable('carry.decideByMin', 10).ok).toBe(false);
  });

  it.each([
    'risk.maxDailyLoss', 'signal.maxDailyLoss', 'signal.lots', 'signal.maxLots', 'signal.defaultLots', 'signal.tradesPerDay', 'signal.maxTradesPerDay',
    'exit.lossLimit', 'exit.hardLossLimit', 'exit.killSwitch', 'exit.holdList', 'hold', 'exit.dailyCap', 'exit.dailyExitCap',
    'signal.maxLossPerTrade', 'exit.lossPerUnderlying', 'signal.positionSize', 'signal.dailyLossStop',
  ])('isForbiddenTarget rejects any name containing maxDailyLoss|lots|tradesPerDay|lossLimit|killSwitch|hold|dailyCap: %s', (t) => {
    expect(isForbiddenTarget(t)).toBe(true);
  });
});
