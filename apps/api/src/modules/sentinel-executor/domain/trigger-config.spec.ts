// apps/api/src/modules/sentinel-executor/domain/trigger-config.spec.ts
import { parseTriggerConfig } from './trigger-config';

describe('parseTriggerConfig (spec §5)', () => {
  it('defaults are the owner-approved ones, and OFF', () => {
    expect(parseTriggerConfig({})).toEqual({
      enabled: false, confirmTicks: 2, confirmMs: 1000, maxAgeMin: 240,
      maxDistancePct: { UNDERLYING: 10, PREMIUM: 60 }, tightenOnly: true, problems: [],
    });
  });

  it('only the exact string true enables', () => {
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: 'true' }).enabled).toBe(true);
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: '1' }).enabled).toBe(false);
  });

  it('tighten-only can only be switched off by the exact string false (D4 fails safe)', () => {
    expect(parseTriggerConfig({ SENTINEL_TRIGGER_TIGHTEN_ONLY: 'false' }).tightenOnly).toBe(false);
    expect(parseTriggerConfig({ SENTINEL_TRIGGER_TIGHTEN_ONLY: 'no' }).tightenOnly).toBe(true);
  });

  it.each([
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '0', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '1.5', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '11', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_MS', '-1', 'confirmMs', 1000],
    ['SENTINEL_TRIGGER_CONFIRM_MS', '10001', 'confirmMs', 1000],
    ['SENTINEL_TRIGGER_MAX_AGE_MIN', '4', 'maxAgeMin', 240],
    ['SENTINEL_TRIGGER_MAX_AGE_MIN', 'abc', 'maxAgeMin', 240],
  ])('%s=%s is out of range → default, reported', (key, raw, field, fallback) => {
    const c = parseTriggerConfig({ [key]: raw });
    expect((c as unknown as Record<string, unknown>)[field]).toBe(fallback);
    expect(c.problems.join(' ')).toContain(key);
  });

  it('accepts in-range values', () => {
    const c = parseTriggerConfig({
      SENTINEL_TRIGGER_CONFIRM_TICKS: '3', SENTINEL_TRIGGER_CONFIRM_MS: '0', SENTINEL_TRIGGER_MAX_AGE_MIN: '60',
      SENTINEL_TRIGGER_MAX_DISTANCE_PCT: 'UNDERLYING:5,PREMIUM:40',
    });
    expect(c).toMatchObject({ confirmTicks: 3, confirmMs: 0, maxAgeMin: 60, maxDistancePct: { UNDERLYING: 5, PREMIUM: 40 } });
    expect(c.problems).toEqual([]);
  });

  it.each([
    ['UNDERLYING:30', 'UNDERLYING'],     // > 25 cap
    ['PREMIUM:0', 'PREMIUM'],
    ['SPOT:5', 'SPOT'],
    ['UNDERLYING', 'UNDERLYING'],
  ])('a bad distance entry %s keeps that instrument at its default', (raw, named) => {
    const c = parseTriggerConfig({ SENTINEL_TRIGGER_MAX_DISTANCE_PCT: raw });
    expect(c.maxDistancePct).toEqual({ UNDERLYING: 10, PREMIUM: 60 });
    expect(c.problems.join(' ')).toContain(named);
  });
});
