// apps/api/src/modules/sentinel-executor/domain/auto-exit.config.spec.ts
import { parseAutoExitConfig } from './auto-exit.config';

describe('parseAutoExitConfig', () => {
  it('defaults are safe: disabled, dry-run, nobody, cap 5, 90 s, 2 %, MCX unit unconfigured', () => {
    expect(parseAutoExitConfig({})).toEqual({
      enabled: false,
      mode: 'dry-run',
      userIds: [],
      dailyCap: 5,
      maxVerdictAgeSec: 90,
      limitFallbackPct: 2,
      qtyUnits: { NFO: 'units', BFO: 'units' },
      cancelProtective: false,
      problems: [],
    });
  });

  it('enabled only on the exact string "true"', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true' }).enabled).toBe(true);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: '1' }).enabled).toBe(false);
  });

  it('live only on the exact string "live"; anything unknown falls back to dry-run with a problem', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'live' }).mode).toBe('live');
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'dry-run' }).mode).toBe('dry-run');
    const c = parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'LIVE' });
    expect(c.mode).toBe('dry-run');
    expect(c.problems).toEqual([expect.stringContaining('AI_AUTO_EXIT_MODE')]);
  });

  it('allow-list is trimmed, de-duplicated, blanks dropped', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_USER_IDS: ' u1, ,u2,u1 ' }).userIds).toEqual(['u1', 'u2']);
  });

  it('out-of-range numbers fall back to defaults with a problem each', () => {
    const c = parseAutoExitConfig({
      AI_AUTO_EXIT_DAILY_CAP: '-1',
      AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC: '5',
      AI_AUTO_EXIT_LIMIT_FALLBACK_PCT: '25',
    });
    expect([c.dailyCap, c.maxVerdictAgeSec, c.limitFallbackPct]).toEqual([5, 90, 2]);
    expect(c.problems).toHaveLength(3);
  });

  it('accepts in-range values, including a cap of 0 (every exit skipped)', () => {
    const c = parseAutoExitConfig({
      AI_AUTO_EXIT_DAILY_CAP: '0',
      AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC: '120',
      AI_AUTO_EXIT_LIMIT_FALLBACK_PCT: '1.5',
    });
    expect([c.dailyCap, c.maxVerdictAgeSec, c.limitFallbackPct, c.problems]).toEqual([0, 120, 1.5, []]);
  });

  it('a non-integer cap is rejected', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_DAILY_CAP: '2.5' }).dailyCap).toBe(5);
  });

  describe('AI_AUTO_EXIT_QTY_UNITS (ruling R16)', () => {
    it('MCX is configured only explicitly; entries merge over the NFO/BFO defaults', () => {
      expect(parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: 'MCX:lots' }).qtyUnits).toEqual({
        NFO: 'units', BFO: 'units', MCX: 'lots',
      });
      expect(parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: ' mcx : UNITS , nfo:units ' }).qtyUnits).toEqual({
        NFO: 'units', BFO: 'units', MCX: 'units',
      });
    });

    it('a malformed entry for an in-scope exchange UN-configures it (fail closed) with a problem', () => {
      const c = parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: 'NFO:lot,MCX:lots' });
      expect(c.qtyUnits).toEqual({ BFO: 'units', MCX: 'lots' });
      expect(c.problems).toEqual([expect.stringContaining('NFO:lot')]);
      const d = parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: 'MCX' });
      expect(d.qtyUnits.MCX).toBeUndefined();
      expect(d.problems).toHaveLength(1);
    });

    it('an out-of-scope exchange is ignored with a problem', () => {
      const c = parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: 'NSE:units' });
      expect(c.qtyUnits).toEqual({ NFO: 'units', BFO: 'units' });
      expect(c.problems).toEqual([expect.stringContaining('NSE')]);
    });

    it('two different units for one exchange un-configure it', () => {
      const c = parseAutoExitConfig({ AI_AUTO_EXIT_QTY_UNITS: 'MCX:lots,MCX:units' });
      expect(c.qtyUnits.MCX).toBeUndefined();
      expect(c.problems).toHaveLength(1);
    });

    it('the result is a fresh object (defaults are never mutated)', () => {
      const a = parseAutoExitConfig({});
      a.qtyUnits.MCX = 'lots';
      expect(parseAutoExitConfig({}).qtyUnits.MCX).toBeUndefined();
    });
  });
});

describe('AI_AUTO_EXIT_CANCEL_PROTECTIVE (cancel the owner\'s protective stop-loss, then exit)', () => {
  it('is on only for the exact string "true"; default off', () => {
    expect(parseAutoExitConfig({}).cancelProtective).toBe(false);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' }).cancelProtective).toBe(true);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'TRUE' }).cancelProtective).toBe(false);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_CANCEL_PROTECTIVE: '1' }).cancelProtective).toBe(false);
  });
});
