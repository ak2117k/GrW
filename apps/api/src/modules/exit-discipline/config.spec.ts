import { EXIT_DISCIPLINE_DEFAULTS, describeExitDiscipline, parseExitDisciplineConfig } from './config';

describe('parseExitDisciplineConfig', () => {
  it('empty env = spec §10 defaults, ON', () => {
    const c = parseExitDisciplineConfig({});
    expect(c).toEqual({ enabled: true, floorHardExit: true, ...EXIT_DISCIPLINE_DEFAULTS, problems: [] });
    expect(EXIT_DISCIPLINE_DEFAULTS).toEqual({
      floorArmN: 1.5, floorTrailN: 2.0, givebackN: 1.5, gateCloseMin: 10, gateUnderlyingN: 1.0,
      persistWindowSec: 300, persistMinSec: 120, outcomeWindowMin: 60, openingGuardMin: 15, floorHardExitN: 2.0,
    });
  });

  it('FLOOR_HARD_EXIT: off only for the exact word false (a typo stays ON and is reported); FLOOR_HARD_EXIT_N is K in 1–6', () => {
    expect(parseExitDisciplineConfig({ FLOOR_HARD_EXIT: 'false' }).floorHardExit).toBe(false);
    expect(parseExitDisciplineConfig({ FLOOR_HARD_EXIT: 'true' }).floorHardExit).toBe(true);
    const typo = parseExitDisciplineConfig({ FLOOR_HARD_EXIT: 'off' });
    expect(typo.floorHardExit).toBe(true);
    expect(typo.problems).toEqual([expect.stringMatching(/FLOOR_HARD_EXIT=off/)]);
    expect(parseExitDisciplineConfig({ FLOOR_HARD_EXIT_N: '2.5' }).floorHardExitN).toBe(2.5);
    const bad = parseExitDisciplineConfig({ FLOOR_HARD_EXIT_N: '0.5' });
    expect(bad.floorHardExitN).toBe(2);
    expect(bad.problems).toEqual([expect.stringMatching(/FLOOR_HARD_EXIT_N=0.5/)]);
  });

  it('only the exact word false turns it off; a typo stays ON (the narrower behaviour) and is reported', () => {
    expect(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }).enabled).toBe(false);
    expect(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'true' }).enabled).toBe(true);
    const typo = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'flase' });
    expect(typo.enabled).toBe(true);
    expect(typo.problems).toEqual([expect.stringMatching(/EXIT_DISCIPLINE_ENABLED=flase/)]);
  });

  it.each([
    ['FLOOR_ARM_N', '2.5', 'floorArmN', 2.5],
    ['FLOOR_TRAIL_N', '3', 'floorTrailN', 3],
    ['GIVEBACK_N', '1', 'givebackN', 1],
    ['GATE_CLOSE_MIN', '15', 'gateCloseMin', 15],
    ['GATE_UNDERLYING_N', '0.5', 'gateUnderlyingN', 0.5],
    ['PERSIST_WINDOW_SEC', '600', 'persistWindowSec', 600],
    ['PERSIST_MIN_SEC', '60', 'persistMinSec', 60],
    ['EXIT_OUTCOME_WINDOW_MIN', '90', 'outcomeWindowMin', 90],
  ])('%s=%s is accepted', (key, raw, field, value) => {
    const c = parseExitDisciplineConfig({ [key]: raw });
    expect((c as unknown as Record<string, number>)[field]).toBe(value);
    expect(c.problems).toEqual([]);
  });

  it.each([
    ['FLOOR_ARM_N', '0'], ['FLOOR_ARM_N', '9'], ['FLOOR_TRAIL_N', 'abc'], ['GIVEBACK_N', '-1'],
    ['GATE_CLOSE_MIN', '1.5'], ['GATE_CLOSE_MIN', '120'], ['GATE_UNDERLYING_N', '10'],
    ['PERSIST_WINDOW_SEC', '5'], ['PERSIST_MIN_SEC', '2000'], ['EXIT_OUTCOME_WINDOW_MIN', '5'],
  ])('%s=%s is out of range → default + one problem', (key, raw) => {
    const c = parseExitDisciplineConfig({ [key]: raw });
    expect(c.problems).toEqual([expect.stringContaining(`${key}=${raw}`)]);
    expect(c).toMatchObject({ ...EXIT_DISCIPLINE_DEFAULTS });
  });

  it('PERSIST_MIN_SEC larger than PERSIST_WINDOW_SEC is allowed (independent rules) but blank values are defaults', () => {
    expect(parseExitDisciplineConfig({ PERSIST_MIN_SEC: ' ' }).persistMinSec).toBe(120);
  });

  it('describeExitDiscipline names every multiplier (the boot log)', () => {
    expect(describeExitDiscipline(parseExitDisciplineConfig({}))).toBe(
      'ON floorArmN=1.5 floorTrailN=2 givebackN=1.5 gateCloseMin=10 gateUnderlyingN=1 persist=300s/120s openingGuard=15m outcomeWindow=60m floorHardExit=ON K=2',
    );
    expect(describeExitDiscipline(parseExitDisciplineConfig({ FLOOR_HARD_EXIT: 'false' }))).toMatch(/ floorHardExit=off$/);
    expect(describeExitDiscipline(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }))).toMatch(/^OFF /);
  });
});
