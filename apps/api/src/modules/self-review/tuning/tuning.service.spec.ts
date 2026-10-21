import { TUNING_REFRESH_MS, TuningService } from './tuning.service';

describe('TuningService', () => {
  const make = (rows: () => Promise<Array<{ target: string; value: unknown }>>) => {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
    const source = { overrides: jest.fn(rows) };
    return { svc: new TuningService(source, () => clock.now()), source, clock };
  };

  it('answers the default before any load and for unknown targets', async () => {
    const { svc } = make(async () => []);
    expect(svc.get('scorecard.factor.oi.weight', 1)).toBe(1);
    await svc.refresh();
    expect(svc.get('scorecard.factor.oi.weight', 1)).toBe(1);
  });

  it('serves valid overrides, ignores unlisted / out-of-bounds / wrong-typed rows', async () => {
    const { svc } = make(async () => [
      { target: 'scorecard.factor.oi.weight', value: 0.5 },
      { target: 'scorecard.factor.vix.weight', value: 9 },
      { target: 'risk.maxDailyLoss', value: 1 },
      { target: 'scorecard.factor.news.requireConfirmation', value: 'yes' },
      { target: 'exit.persistMinSec', value: 300 },
    ]);
    await svc.refresh();
    expect(svc.get('scorecard.factor.oi.weight', 1)).toBe(0.5);
    expect(svc.get('scorecard.factor.vix.weight', 1)).toBe(1);
    expect(svc.get('risk.maxDailyLoss', 7)).toBe(7);
    expect(svc.get('scorecard.factor.news.requireConfirmation', false)).toBe(false);
    expect(svc.get('exit.persistMinSec', 120)).toBe(300);
    expect(svc.snapshot()).toEqual({ 'scorecard.factor.oi.weight': 0.5, 'exit.persistMinSec': 300 });
  });

  it('re-reads at most every 60 s, single-flight, from get()', async () => {
    const { svc, source, clock } = make(async () => [{ target: 'scorecard.factor.oi.weight', value: 0.5 }]);
    await svc.refresh();
    svc.get('scorecard.factor.oi.weight', 1);
    svc.get('scorecard.factor.oi.weight', 1);
    expect(source.overrides).toHaveBeenCalledTimes(1);
    clock.advance(TUNING_REFRESH_MS);
    svc.get('scorecard.factor.oi.weight', 1);
    svc.get('scorecard.factor.oi.weight', 1);
    expect(source.overrides).toHaveBeenCalledTimes(2);
  });

  it('a DB failure → every value falls back to the code default', async () => {
    let fail = false;
    const { svc } = make(async () => {
      if (fail) throw new Error('db down');
      return [{ target: 'scorecard.factor.oi.weight', value: 0.5 }];
    });
    await svc.refresh();
    expect(svc.get('scorecard.factor.oi.weight', 1)).toBe(0.5);
    fail = true;
    await svc.refresh();
    expect(svc.get('scorecard.factor.oi.weight', 1)).toBe(1);
  });

  it('a type mismatch with the fallback answers the fallback', async () => {
    const { svc } = make(async () => [{ target: 'scorecard.factor.oi.weight', value: 0.5 }]);
    await svc.refresh();
    expect(svc.get('scorecard.factor.oi.weight', true)).toBe(true);
  });
});
