import {
  parseRejudgeConfig,
  rejudgeSnapshot,
  repeatIsMaterial,
  suppressRepeatJudgements,
  SUPPRESSIBLE_FIRES,
  type RejudgeSnapshot,
} from './rejudge-suppression';
import type { TripwireResult } from './tripwire.service';

const cfg = parseRejudgeConfig({});

function snap(over: Partial<RejudgeSnapshot> = {}): RejudgeSnapshot {
  return { at: 0, ltp: 100, qty: 50, peak: 120, pullback: 20, volumeRatio: 2.5, noiseN: null, excursion: 20, ...over };
}

function fired(...names: string[]): TripwireResult {
  return { fires: names.map((name) => ({ name, detail: name })), heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' };
}

describe('parseRejudgeConfig', () => {
  it('defaults ON with conservative thresholds', () => {
    expect(cfg).toEqual({
      enabled: true,
      cooldownMs: 10 * 60_000,
      priceMovePct: 0.02,
      givebackDeepenN: 0.5,
      givebackDeepenFrac: 0.1,
    });
  });

  it('rollback: SENTINEL_REJUDGE_SUPPRESSION=false turns it off', () => {
    expect(parseRejudgeConfig({ SENTINEL_REJUDGE_SUPPRESSION: 'false' }).enabled).toBe(false);
  });

  it('reads overrides and ignores garbage', () => {
    const c = parseRejudgeConfig({
      SENTINEL_REJUDGE_COOLDOWN_MIN: '5',
      SENTINEL_REJUDGE_PRICE_MOVE_PCT: '0.03',
      SENTINEL_REJUDGE_GIVEBACK_DEEPEN_N: 'abc',
      SENTINEL_REJUDGE_GIVEBACK_DEEPEN_FRAC: '-1',
    });
    expect(c.cooldownMs).toBe(5 * 60_000);
    expect(c.priceMovePct).toBe(0.03);
    expect(c.givebackDeepenN).toBe(0.5);
    expect(c.givebackDeepenFrac).toBe(0.1);
  });
});

describe('rejudgeSnapshot', () => {
  it('measures the pullback off the running extreme for each side', () => {
    const long = rejudgeSnapshot({ side: 'LONG', entryPrice: 100, ltp: 110, qty: 1, holdingHigh: 130, holdingLow: 95, volumeRatio: null }, null, 5);
    expect(long).toMatchObject({ peak: 130, pullback: 20, excursion: 30, at: 5 });
    const short = rejudgeSnapshot({ side: 'SHORT', entryPrice: 100, ltp: 90, qty: 1, holdingHigh: 105, holdingLow: 80, volumeRatio: 2 }, 3, 5);
    expect(short).toMatchObject({ peak: 80, pullback: 10, excursion: 20, noiseN: 3, volumeRatio: 2 });
  });

  it('leaves the giveback fields null without a finite peak', () => {
    const s = rejudgeSnapshot({ side: 'LONG', entryPrice: 100, ltp: 110, qty: 1, holdingHigh: null, holdingLow: null, volumeRatio: null }, null, 0);
    expect(s.peak).toBeNull();
    expect(s.pullback).toBeNull();
  });
});

describe('repeatIsMaterial', () => {
  const base = snap({ at: 0 });

  it('no baseline is always material', () => {
    expect(repeatIsMaterial('giveback-off-peak', undefined, base, cfg)).toBe(true);
  });

  it('an unchanged giveback inside the cooldown is NOT material', () => {
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 60_000, ltp: 100.5, pullback: 19.5 }), cfg)).toBe(false);
  });

  it('the cooldown elapsing is material', () => {
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: cfg.cooldownMs }), cfg)).toBe(true);
  });

  it('a quantity change is material', () => {
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1, qty: 25 }), cfg)).toBe(true);
  });

  it('a price move beyond priceMovePct is material, either direction', () => {
    expect(repeatIsMaterial('volume-anomaly', base, snap({ at: 1, ltp: 102 }), cfg)).toBe(true);
    expect(repeatIsMaterial('volume-anomaly', base, snap({ at: 1, ltp: 98 }), cfg)).toBe(true);
    expect(repeatIsMaterial('volume-anomaly', base, snap({ at: 1, ltp: 101.9 }), cfg)).toBe(false);
  });

  it('a new peak is material for giveback', () => {
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1, peak: 121 }), cfg)).toBe(true);
  });

  it('giveback deepening by >= deepenFrac of the excursion is material (no noise unit)', () => {
    // excursion 20, frac 0.1 -> 2.0
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1, pullback: 21.9, ltp: 98.5 }), cfg)).toBe(false);
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1, pullback: 22, ltp: 98.5 }), cfg)).toBe(true);
  });

  it('with a noise unit, deepening by >= givebackDeepenN * N is material', () => {
    const b = snap({ noiseN: 2 });
    expect(repeatIsMaterial('giveback-off-peak', b, snap({ at: 1, noiseN: 2, pullback: 20.9 }), cfg)).toBe(false);
    expect(repeatIsMaterial('giveback-off-peak', b, snap({ at: 1, noiseN: 2, pullback: 21 }), cfg)).toBe(true);
  });

  it('a different volume ratio (a newly closed bar) is material for volume-anomaly', () => {
    expect(repeatIsMaterial('volume-anomaly', base, snap({ at: 1 }), cfg)).toBe(false);
    expect(repeatIsMaterial('volume-anomaly', base, snap({ at: 1, volumeRatio: 2.6 }), cfg)).toBe(true);
  });

  it('a non-finite baseline price is material (fail open)', () => {
    expect(repeatIsMaterial('giveback-off-peak', snap({ ltp: NaN }), snap({ at: 1 }), cfg)).toBe(true);
  });
});

describe('suppressRepeatJudgements', () => {
  const baselines = { 'giveback-off-peak': snap(), 'volume-anomaly': snap() };
  const now = snap({ at: 60_000 });

  it('only the two level-triggered sensors are suppressible', () => {
    expect([...SUPPRESSIBLE_FIRES].sort()).toEqual(['giveback-off-peak', 'volume-anomaly']);
  });

  it('drops an unchanged repeat and stops the wake', () => {
    const r = suppressRepeatJudgements(fired('giveback-off-peak', 'volume-anomaly'), baselines, now, cfg);
    expect(r.suppressed).toEqual(['giveback-off-peak', 'volume-anomaly']);
    expect(r.decision.fires).toEqual([]);
    expect(r.decision.shouldEvaluate).toBe(false);
    expect(r.decision.trigger).toBeNull();
  });

  it('never suppresses when any other sensor fired — the whole decision passes through', () => {
    for (const other of ['level-break', 'exit-confirm', 'news-hit', 'event-near', 'oi-wall-shift', 'context-factor-flip']) {
      const d = fired('giveback-off-peak', other);
      const r = suppressRepeatJudgements(d, baselines, now, cfg);
      expect(r.suppressed).toEqual([]);
      expect(r.decision).toBe(d);
    }
  });

  it('passes through when one suppressible fire is material', () => {
    const d = fired('giveback-off-peak', 'volume-anomaly');
    const r = suppressRepeatJudgements(d, baselines, snap({ at: 60_000, volumeRatio: 3.1 }), cfg);
    expect(r.suppressed).toEqual([]);
    expect(r.decision).toBe(d);
  });

  it('passes a heartbeat decision through untouched', () => {
    const d: TripwireResult = { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' };
    expect(suppressRepeatJudgements(d, baselines, now, cfg).decision).toBe(d);
  });

  it('is a no-op when disabled', () => {
    const d = fired('giveback-off-peak');
    const r = suppressRepeatJudgements(d, baselines, now, { ...cfg, enabled: false });
    expect(r.decision).toBe(d);
    expect(r.suppressed).toEqual([]);
  });
});
