import {
  BREAKOUT_BODY_ATR,
  RR_FLOOR_STRICT,
  SL_BUFFER_ATR,
  buildTradePlan,
  collectLevelCandidates,
  computeSetupPrices,
  rewardRisk,
  type BuildTradePlanInput,
} from './trade-plan';
import type { AnalyzeResult, LevelsSnapshot } from './signal-generator.service';

/**
 * The plan is what the chart draws AND what the card reads, so the properties
 * under test are mostly about what it must NEVER do: fabricate a level, show a
 * trade the engine could only reject, disagree with the live setup arithmetic,
 * or leak an engine debug string to a trader.
 *
 * See docs/superpowers/specs/2026-08-07-trade-plan-design.md §5.
 */

const ATR = 10;

/** Spot 1000, with levels spaced far enough apart to clear the R:R floor. */
const LEVELS: LevelsSnapshot = {
  pdh: 1020,
  pdl: 980,
  orh: 1060,
  orl: 940,
  prevOrh: null,
  prevOrl: null,
  // Well clear of spot and of PDL, so the nearest level on each side is
  // unambiguously PDH above / PDL below and the ordering assertions mean
  // something.
  vwap: 950,
  todayHigh: 1030,
  todayLow: 970,
  atr14: ATR,
};

function input(over: Partial<BuildTradePlanInput> = {}): BuildTradePlanInput {
  return { analysis: null, levels: LEVELS, ltp: 1000, atr14: ATR, ...over };
}

function setup(over: Partial<Record<string, unknown>> = {}): AnalyzeResult {
  return {
    kind: 'setup',
    symbol: 'CUPID',
    side: 'BUY',
    entry: 1021.5,
    stoploss: 1017.5,
    target: 1030,
    levelType: 'PDH',
    setupType: 'BREAKOUT',
    grade: 'A',
    ...over,
  } as unknown as AnalyzeResult;
}

describe('buildTradePlan — active', () => {
  it('promotes an /analyze setup to the active trigger', () => {
    const plan = buildTradePlan(input({ analysis: setup() }));

    expect(plan.active).toMatchObject({
      side: 'BUY',
      levelSource: 'PDH',
      entry: 1021.5,
      stoploss: 1017.5,
      target: 1030,
      state: 'active',
    });
    // entry IS the price that arms a live trade, and it is the line already
    // drawn for an active setup — so it is the trigger price too.
    expect(plan.active!.triggerPrice).toBe(1021.5);
  });

  it('leaves active null when /analyze reports no setup', () => {
    const plan = buildTradePlan(input({ analysis: { kind: 'no-setup' } as never }));
    expect(plan.active).toBeNull();
  });

  /**
   * A setup missing a price is a broken setup, not a tradeable one. Rendering
   * it would put a NaN R:R in front of a trader.
   */
  it.each(['entry', 'stoploss', 'target'])(
    'refuses an active trigger when %s is not a real price',
    (field) => {
      expect(buildTradePlan(input({ analysis: setup({ [field]: 0 }) })).active).toBeNull();
      expect(buildTradePlan(input({ analysis: setup({ [field]: NaN }) })).active).toBeNull();
      expect(buildTradePlan(input({ analysis: setup({ [field]: null }) })).active).toBeNull();
    },
  );
});

describe('buildTradePlan — pending triggers', () => {
  it('returns the nearest qualifying level on each side of spot', () => {
    const plan = buildTradePlan(input());

    expect(plan.above).toMatchObject({ side: 'BUY', state: 'pending' });
    expect(plan.below).toMatchObject({ side: 'SELL', state: 'pending' });
    expect(plan.above!.triggerPrice).toBeGreaterThan(1000);
    expect(plan.below!.triggerPrice).toBeLessThan(1000);
  });

  it('picks the NEAREST qualifying level, not merely the first in the book', () => {
    // PDH 1020 is nearer than ORH 1060; the book lists PDH first anyway, so
    // put a nearer ROUND level in to prove the sort is doing the work.
    const plan = buildTradePlan(input({ roundNumbers: [1005] }));
    expect(plan.above!.triggerPrice).toBe(1005);
    expect(plan.above!.levelSource).toBe('ROUND');
  });

  it('is one-sided when only one side has a level', () => {
    const onlyAbove: LevelsSnapshot = { ...LEVELS, pdl: 1010, orl: 1015, vwap: 1030 };
    const plan = buildTradePlan(input({ levels: onlyAbove }));

    expect(plan.above).not.toBeNull();
    expect(plan.below).toBeNull();
  });

  it('is empty — never fabricated — when no input supports a plan', () => {
    expect(buildTradePlan(input({ levels: null }))).toEqual({
      active: null,
      above: null,
      below: null,
    });
    expect(buildTradePlan(input({ ltp: null }))).toEqual({
      active: null,
      above: null,
      below: null,
    });
    expect(buildTradePlan(input({ atr14: null }))).toEqual({
      active: null,
      above: null,
      below: null,
    });
  });

  /**
   * The whole reason pending triggers run the live arithmetic rather than a
   * cheaper approximation: a level that could only ever be rejected must be
   * skipped, not shown to a trader as a trade.
   */
  it('skips a level whose R:R cannot clear the live floor', () => {
    // Two levels 0.2 ATR apart: the target lands at the 2R fallback, which is
    // exactly the floor — while a level with no room above it still qualifies
    // via the fallback. Assert the floor is applied, not that nothing passes.
    const plan = buildTradePlan(input());
    for (const t of [plan.above, plan.below]) {
      expect(t!.rr).toBeGreaterThanOrEqual(RR_FLOOR_STRICT);
    }
  });

  it('never emits a trigger at an evidence-only level', () => {
    // 1002 is not in the anchored/round/vol-strike book. The live engine cannot
    // fire there, so neither may the plan — evidence only colours the sentence.
    const plan = buildTradePlan(
      input({ evidence: [{ price: 1002, score: 91 }] as never }),
    );
    expect(plan.above!.triggerPrice).not.toBe(1002);
  });

  it('annotates a trigger that evidence corroborates, within ATR tolerance', () => {
    const plan = buildTradePlan(input({ evidence: [{ price: 1020, score: 82 }] as never }));
    expect(plan.above!.reason).toContain('Backed by evidence scoring 82');
  });
});

describe('buildTradePlan — R:R arithmetic', () => {
  it('derives rr from the trigger’s own prices', () => {
    const plan = buildTradePlan(input({ analysis: setup() }));
    const t = plan.active!;
    expect(t.rr).toBeCloseTo(Math.abs(t.target - t.entry) / Math.abs(t.entry - t.stoploss), 10);
  });

  it('rewardRisk is direction-agnostic', () => {
    expect(rewardRisk(100, 95, 110)).toBeCloseTo(2, 10); // long
    expect(rewardRisk(100, 105, 90)).toBeCloseTo(2, 10); // short
  });

  it('rewardRisk does not divide by zero on a collapsed stop', () => {
    expect(Number.isFinite(rewardRisk(100, 100, 110))).toBe(true);
  });
});

describe('shared setup arithmetic — pending and live cannot drift', () => {
  /**
   * The parity property the spec exists to guarantee: a pending trigger and
   * the trade it becomes are produced by the SAME function, so they cannot
   * disagree. `LevelsContextStrategy` delegates to `computeSetupPrices` too,
   * which closes the loop.
   */
  it('a pending trigger reproduces computeSetupPrices exactly', () => {
    const plan = buildTradePlan(input());
    const t = plan.above!;
    const direct = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: true,
      level: t.triggerPrice,
      atr: ATR,
      candidates: collectLevelCandidates({
        pdh: LEVELS.pdh,
        pdl: LEVELS.pdl,
        vwap: LEVELS.vwap,
        orh: LEVELS.orh,
        orl: LEVELS.orl,
      }),
    })!;

    expect(t.entry).toBe(direct.entry);
    expect(t.stoploss).toBe(direct.stoploss);
    expect(t.target).toBe(direct.target);
  });

  it('places a long breakout entry above and its stop below the level', () => {
    const p = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: true,
      level: 1000,
      atr: ATR,
      candidates: [],
    })!;
    expect(p.entry).toBeCloseTo(1000 + BREAKOUT_BODY_ATR * ATR, 10);
    expect(p.stoploss).toBeCloseTo(1000 - SL_BUFFER_ATR * ATR, 10);
  });

  it('mirrors the offsets for a short', () => {
    const p = computeSetupPrices({
      setupType: 'BREAKOUT',
      isLong: false,
      level: 1000,
      atr: ATR,
      candidates: [],
    })!;
    expect(p.entry).toBeCloseTo(1000 - BREAKOUT_BODY_ATR * ATR, 10);
    expect(p.stoploss).toBeCloseTo(1000 + SL_BUFFER_ATR * ATR, 10);
  });

  it('a REVERSAL without its confirming close is unplannable, not guessed', () => {
    expect(
      computeSetupPrices({
        setupType: 'REVERSAL',
        isLong: true,
        level: 1000,
        atr: ATR,
        candidates: [],
      }),
    ).toBeNull();
  });

  it('drops a level whose stop distance collapses', () => {
    expect(
      computeSetupPrices({
        setupType: 'BREAKOUT',
        isLong: true,
        level: 1000,
        atr: 0,
        candidates: [],
      }),
    ).toBeNull();
  });
});

describe('collectLevelCandidates', () => {
  it('keeps the strategy’s iteration order — analyze() takes the FIRST confirming level', () => {
    const out = collectLevelCandidates({
      pdh: 110,
      pdl: 90,
      vwap: 100,
      orh: 115,
      orl: 85,
      roundNumbers: [120],
      topVolStrikes: [125],
    });
    expect(out.map((l) => l.type)).toEqual([
      'PDH',
      'PDL',
      'VWAP',
      'ORH',
      'ORL',
      'ROUND',
      'VOL_STRIKE',
    ]);
  });

  it('drops absent and nonsensical levels rather than scanning them', () => {
    const out = collectLevelCandidates({ pdh: 110, pdl: 0, vwap: NaN, orh: null, orl: null });
    expect(out).toEqual([{ type: 'PDH', value: 110 }]);
  });
});

describe('buildTradePlan — nothing hostile reaches the card', () => {
  /**
   * Spec §3.3: the raw `reject:confirmation {...}` string must never reach the
   * UI. Every sentence is composed from numbers and enum labels, so today this
   * can only pass — which is the point. It fails the day someone interpolates
   * an engine string into a reason.
   */
  it('emits plain sentences with no debug payload', () => {
    const plan = buildTradePlan(input({ analysis: setup() }));
    for (const t of [plan.active, plan.above, plan.below]) {
      if (!t) continue;
      expect(t.reason).not.toMatch(/reject:/);
      expect(t.reason).not.toMatch(/[{}]/);
      expect(t.reason.length).toBeGreaterThan(0);
    }
  });

  it('never throws — a malformed input yields an empty plan', () => {
    expect(() => buildTradePlan({} as never)).not.toThrow();
    expect(() => buildTradePlan(input({ evidence: 'not an array' as never }))).not.toThrow();
    expect(() => buildTradePlan(input({ levels: { pdh: 'x' } as never }))).not.toThrow();
  });
});
