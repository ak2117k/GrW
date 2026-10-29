import {
  parseRejudgeConfig,
  priceMoveIsMaterial,
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
      priceMoveNEq: 3,
      priceMovePctEq: 0.004,
      givebackDeepenN: 0.5,
      givebackDeepenFrac: 0.1,
      routineOnCooldown: true,
    });
  });

  it('SENTINEL_REJUDGE_ROUTINE_TIER=false keeps cooldown re-asks on the FIRE tier', () => {
    expect(parseRejudgeConfig({ SENTINEL_REJUDGE_ROUTINE_TIER: 'false' }).routineOnCooldown).toBe(false);
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

  it('the four level-triggered sensors are suppressible (news-hit and level-break since 2026-10-22)', () => {
    expect([...SUPPRESSIBLE_FIRES].sort()).toEqual(['giveback-off-peak', 'level-break', 'news-hit', 'volume-anomaly']);
  });

  it('drops an unchanged repeat and stops the wake', () => {
    const r = suppressRepeatJudgements(fired('giveback-off-peak', 'volume-anomaly'), baselines, now, cfg);
    expect(r.suppressed).toEqual(['giveback-off-peak', 'volume-anomaly']);
    expect(r.decision.fires).toEqual([]);
    expect(r.decision.shouldEvaluate).toBe(false);
    expect(r.decision.trigger).toBeNull();
  });

  it('never suppresses when any other sensor fired — the whole decision passes through', () => {
    for (const other of ['exit-confirm', 'event-near', 'oi-wall-shift', 'context-factor-flip']) {
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

  describe('cooldown-only re-ask goes to the ROUTINE tier', () => {
    const late = snap({ at: cfg.cooldownMs });

    it('keeps the fires but asks at the HEARTBEAT (routine) tier when only the cooldown elapsed', () => {
      const r = suppressRepeatJudgements(fired('giveback-off-peak'), baselines, late, cfg);
      expect(r.suppressed).toEqual([]);
      expect(r.decision.fires.map((f) => f.name)).toEqual(['giveback-off-peak']);
      expect(r.decision.shouldEvaluate).toBe(true);
      expect(r.decision.trigger).toBe('HEARTBEAT');
    });

    it('stays FIRE when something material changed as well (price move after the cooldown)', () => {
      const d = fired('giveback-off-peak');
      const r = suppressRepeatJudgements(d, baselines, snap({ at: cfg.cooldownMs, ltp: 103 }), cfg);
      expect(r.decision).toBe(d);
    });

    it('stays FIRE for a deepening giveback after the cooldown', () => {
      const d = fired('giveback-off-peak');
      const r = suppressRepeatJudgements(d, baselines, snap({ at: cfg.cooldownMs, pullback: 23, ltp: 99 }), cfg);
      expect(r.decision).toBe(d);
    });

    it('stays FIRE when any other sensor fired', () => {
      const d = fired('giveback-off-peak', 'event-near');
      expect(suppressRepeatJudgements(d, baselines, late, cfg).decision).toBe(d);
    });

    it('stays FIRE without a baseline (first time the judge hears this fire)', () => {
      const d = fired('giveback-off-peak');
      expect(suppressRepeatJudgements(d, {}, late, cfg).decision).toBe(d);
    });

    it('stays FIRE when SENTINEL_REJUDGE_ROUTINE_TIER is off', () => {
      const d = fired('giveback-off-peak');
      expect(suppressRepeatJudgements(d, baselines, late, { ...cfg, routineOnCooldown: false }).decision).toBe(d);
    });
  });
});

describe('material-change gating (2026-10-22): news ids, broken levels, edge flags, review time', () => {
  const base = snap({ at: 0 });

  it('news-hit: dedup per headline id — a repeat with no unseen id is not material, one unseen id is', () => {
    const b = snap({ newsUnjudged: 0, newsCount: 2 });
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: 0, newsCount: 2 }), cfg)).toBe(false);
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: 1, newsCount: 3 }), cfg)).toBe(true);
    // ids known: the count alone moving (an old headline aging out, or in) is not new.
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: 0, newsCount: 5 }), cfg)).toBe(false);
  });

  it('news-hit without ids falls back to a higher 30-minute count; unknown counts fail open', () => {
    const b = snap({ newsUnjudged: null, newsCount: 2 });
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: null, newsCount: 2 }), cfg)).toBe(false);
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: null, newsCount: 1 }), cfg)).toBe(false);
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: null, newsCount: 3 }), cfg)).toBe(true);
    expect(repeatIsMaterial('news-hit', b, snap({ at: 1, newsUnjudged: null, newsCount: null }), cfg)).toBe(true);
  });

  it('level-break: the same broken level is not new; a different one is', () => {
    const b = snap({ level: 24000 });
    expect(repeatIsMaterial('level-break', b, snap({ at: 1, level: 24000 }), cfg)).toBe(false);
    expect(repeatIsMaterial('level-break', b, snap({ at: 1, level: 23900 }), cfg)).toBe(true);
    expect(repeatIsMaterial('level-break', b, snap({ at: 1, level: null }), cfg)).toBe(true);
  });

  it('a floor breach, an exitTrigger cross or a hard-risk window APPEARING is material; persisting is not', () => {
    for (const k of ['floorBreached', 'triggerCrossed', 'hardRisk'] as const) {
      expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1, [k]: true }), cfg)).toBe(true);
      expect(repeatIsMaterial('giveback-off-peak', snap({ [k]: true }), snap({ at: 1, [k]: true }), cfg)).toBe(false);
    }
  });

  it('reviewDue replaces the flat cooldown: not due ⇒ an old repeat stays unchanged; due ⇒ material', () => {
    const late = snap({ at: cfg.cooldownMs * 3 });
    expect(repeatIsMaterial('giveback-off-peak', base, late, cfg, false)).toBe(false);
    expect(repeatIsMaterial('giveback-off-peak', base, snap({ at: 1 }), cfg, true)).toBe(true);
    // Omitted: the cooldown as before.
    expect(repeatIsMaterial('giveback-off-peak', base, late, cfg)).toBe(true);
  });

  it('a news repeat material only because the review time elapsed is asked at the routine tier', () => {
    const b = { 'news-hit': snap({ newsUnjudged: 0, newsCount: 1 }) };
    const r = suppressRepeatJudgements(fired('news-hit'), b, snap({ at: 1, newsUnjudged: 0, newsCount: 1 }), cfg, true);
    expect(r.suppressed).toEqual([]);
    expect(r.decision.trigger).toBe('HEARTBEAT');
    expect(r.decision.fires.map((f) => f.name)).toEqual(['news-hit']);
    // ... and is dropped while the review time has not come.
    expect(suppressRepeatJudgements(fired('news-hit'), b, snap({ at: 1, newsUnjudged: 0, newsCount: 1 }), cfg, false).suppressed).toEqual(['news-hit']);
    // A NEW headline keeps the strong tier.
    expect(suppressRepeatJudgements(fired('news-hit'), b, snap({ at: 1, newsUnjudged: 1, newsCount: 2 }), cfg, false).decision.trigger).toBe('FIRE');
  });
});

describe('cash equity: the always-material price step is the equity one', () => {
  const pm = (segment: any, ltp: number, noiseN: number | null = null) =>
    priceMoveIsMaterial(cfg, { ltp: 100, noiseN, segment }, { ltp, noiseN, segment });

  it('F&O and unknown keep 2 % exactly, whatever the noise unit', () => {
    expect([pm('OPT', 102), pm('OPT', 101.9), pm('FUT', 98), pm(undefined, 101.9)]).toEqual([true, false, true, false]);
    expect(pm('OPT', 100.5, 0.1)).toBe(false); // 5 N but only 0.5 %
  });

  it('cash with a noise unit: 3 N either way', () => {
    expect([pm('EQ_INTRADAY', 100.3, 0.1), pm('EQ_INTRADAY', 99.7, 0.1), pm('EQ_INTRADAY', 100.29, 0.1)]).toEqual([true, true, false]);
  });

  it('cash without a noise unit: the 0.4 % fallback', () => {
    expect([pm('EQ_INTRADAY', 100.4), pm('EQ_INTRADAY', 100.3)]).toEqual([true, false]);
    const c = parseRejudgeConfig({ SENTINEL_REJUDGE_PRICE_MOVE_PCT_EQ: '0.01' });
    expect(priceMoveIsMaterial(c, { ltp: 100, noiseN: null, segment: 'EQ_INTRADAY' }, { ltp: 100.5, noiseN: null, segment: 'EQ_INTRADAY' })).toBe(false);
  });

  it('through repeatIsMaterial: a 0.5 % stock move is material on equity and NOT on an option', () => {
    // volume-anomaly with an unchanged ratio: only the price rule can make it material.
    const eqBase = snap({ at: 0, segment: 'EQ_INTRADAY' });
    expect(repeatIsMaterial('volume-anomaly', eqBase, snap({ at: 1, ltp: 100.5, segment: 'EQ_INTRADAY' }), cfg)).toBe(true);
    expect(repeatIsMaterial('volume-anomaly', eqBase, snap({ at: 1, ltp: 100.3, segment: 'EQ_INTRADAY' }), cfg)).toBe(false);
    const optBase = snap({ at: 0, segment: 'OPT' });
    expect(repeatIsMaterial('volume-anomaly', optBase, snap({ at: 1, ltp: 100.5, segment: 'OPT' }), cfg)).toBe(false);
    expect(repeatIsMaterial('volume-anomaly', optBase, snap({ at: 1, ltp: 102, segment: 'OPT' }), cfg)).toBe(true);
  });

  it('rejudgeSnapshot carries the segment only when given, so old callers build the same snapshot', () => {
    const t = { side: 'LONG' as const, entryPrice: 100, ltp: 101, qty: 1, holdingHigh: 102, holdingLow: 99, volumeRatio: null };
    expect('segment' in rejudgeSnapshot(t, null, 0)).toBe(false);
    expect(rejudgeSnapshot({ ...t, segment: 'EQ_INTRADAY' }, null, 0).segment).toBe('EQ_INTRADAY');
  });
});
