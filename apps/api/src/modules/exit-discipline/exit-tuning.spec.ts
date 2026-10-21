import { parseExitDisciplineConfig, withExitTuning } from './config';

const reader = (m: Record<string, unknown>) => ({ get: <T extends number | boolean>(t: string, d: T): T => (t in m ? (m[t] as T) : d) });

describe('withExitTuning (self-review overrides of exit discipline)', () => {
  const env = parseExitDisciplineConfig({ EXIT_OPENING_GUARD_MIN: '10', PERSIST_MIN_SEC: '180' });

  it('no reader / no override → the env config, same object', () => {
    expect(withExitTuning(env, null)).toBe(env);
    expect(withExitTuning(env, reader({}))).toBe(env);
  });

  it('an override wins over env', () => {
    const c = withExitTuning(env, reader({ 'exit.openingGuardMin': 25, 'exit.persistMinSec': 300 }));
    expect(c.openingGuardMin).toBe(25);
    expect(c.persistMinSec).toBe(300);
    expect(c.floorArmN).toBe(env.floorArmN);
  });

  it('is still bounded: out-of-range or non-integer overrides keep env', () => {
    const c = withExitTuning(env, reader({ 'exit.openingGuardMin': 45, 'exit.persistMinSec': 30 }));
    expect(c.openingGuardMin).toBe(10);
    expect(c.persistMinSec).toBe(180);
    expect(withExitTuning(env, reader({ 'exit.openingGuardMin': 12.5 })).openingGuardMin).toBe(10);
  });

  it('a reader that throws keeps env', () => {
    const c = withExitTuning(env, { get: () => { throw new Error('db'); } });
    expect(c).toEqual(env);
  });
});
