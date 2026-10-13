import { currentCoreAlertIntake, handOffChartinkHit, setCoreAlertIntake } from './alert-handoff';
import { hit } from './testing/intake-fixtures';

afterEach(() => setCoreAlertIntake(null));

describe('handOffChartinkHit (ruling J2)', () => {
  it('does nothing when no intake is registered (entries off)', () => {
    expect(currentCoreAlertIntake()).toBeNull();
    expect(() => handOffChartinkHit(hit())).not.toThrow();
  });

  it('hands the hit to the registered intake, synchronously', () => {
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    handOffChartinkHit(hit());
    expect(accept).toHaveBeenCalledWith(hit());
  });

  it('never throws, even when the intake does', () => {
    setCoreAlertIntake({ accept: () => { throw new Error('core broke'); } });
    expect(() => handOffChartinkHit(hit())).not.toThrow();
  });
});
