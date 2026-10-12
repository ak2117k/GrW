import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { adaptiveBlocks, plainBlocks } from '../strategies/testing/block-fixtures';
import { armLevels, buildExitPlan, resolveStopPct, resolveTargetPct, type PlanInput } from './exit-plan';
import { adaptivePlan, cashPlan, mtfBlocks, NOW, optionBlocks, optionPlan } from './testing/lifecycle-fixtures';

const atrStop = { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 } as const;

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { blocks: plainBlocks(), vehicle: 'CASH_INTRADAY', side: 'BUY', refPrice: 500, atr: null, limits: limitsFixture(), option: null, now: NOW, ...over };
}

describe('resolveStopPct / resolveTargetPct (spec §4.1)', () => {
  it('a fixed stop is its percent', () => {
    expect(resolveStopPct({ kind: 'fixedPct', pct: 1.5 }, 500, null)).toBe(1.5);
  });

  it('an ATR stop is multiple × ATR as a percent of the reference, clamped to [minPct, maxPct]', () => {
    expect(resolveStopPct(atrStop, 500, 5)).toBeCloseTo(1.2, 10);
    expect(resolveStopPct(atrStop, 500, 3)).toBe(0.8);
    expect(resolveStopPct(atrStop, 500, 20)).toBe(2.5);
  });

  it('an ATR stop without a usable ATR is the floor (the silo rule, adaptive-stop-math.ts resolveStop)', () => {
    expect(resolveStopPct(atrStop, 500, null)).toBe(0.8);
    expect(resolveStopPct(atrStop, 500, 0)).toBe(0.8);
  });

  it('a target is a percent, or a reward:risk multiple of the stop', () => {
    expect(resolveTargetPct({ kind: 'fixedPct', pct: 2 }, 1.5)).toBe(2);
    expect(resolveTargetPct({ kind: 'rr', ratio: 2 }, 1.5)).toBe(3);
  });
});

describe('buildExitPlan', () => {
  it('freezes the blocks, the ATR and the snapshot limits', () => {
    const r = buildExitPlan(input({ blocks: adaptiveBlocks(), atr: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({
      version: 1,
      vehicle: 'CASH_INTRADAY',
      side: 'BUY',
      targetPct: 2,
      trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
      partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
      timeExit: { kind: 'clock', hhmm: '15:15' },
      atr: 5,
      squareOffHhmm: '15:15',
      mtfMaxHoldDays: null,
      entryDay: '2026-10-12',
      option: null,
    });
    expect(r.plan.stopPct).toBeCloseTo(1.2, 10);
  });

  it('MTF freezes mtfMaxHoldDays and its square-off time', () => {
    const r = buildExitPlan(input({ blocks: mtfBlocks(), vehicle: 'MTF' }));
    expect(r.ok && r.plan).toMatchObject({ squareOffHhmm: '15:20', mtfMaxHoldDays: 10, timeExit: { kind: 'holdDays', n: 3 } });
  });

  it('options: the stop is the tighter of the stop block and the premium stop (O3), and the contract is frozen', () => {
    const p = optionPlan();
    expect(p.stopPct).toBe(25);
    expect(p.targetPct).toBe(50);
    expect(p.option).toEqual({
      optionType: 'CE',
      expiry: '2026-10-15',
      premiumStopPct: 25,
      thetaStop: { minMovePct: 10, withinMinutes: 30 },
      expiryDayExitHhmm: '14:30',
      underlyingRef: null,
      underlyingStopPrice: null,
    });
  });

  it('fails closed on what it cannot plan', () => {
    const err = (over: Partial<PlanInput>) => {
      const r = buildExitPlan(input(over));
      return r.ok ? null : r.error;
    };
    const ce = { optionType: 'CE' as const, expiry: '2026-10-15', underlyingRef: null, underlyingStopPrice: null };
    expect(err({ vehicle: 'MTF' })).toBe('the version trades CASH_INTRADAY, not MTF');
    expect(err({ limits: limitsFixture({ 'squareOffTime@CASH_INTRADAY': null }) })).toBe('squareOffTime@CASH_INTRADAY is missing from the limits snapshot');
    expect(err({ blocks: mtfBlocks(), vehicle: 'MTF', limits: limitsFixture({ 'mtfMaxHoldDays@MTF': null }) })).toBe('mtfMaxHoldDays@MTF is missing from the limits snapshot');
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY' })).toBe('an OPTIONS_BUY position needs its contract (optionType, expiry)');
    expect(err({ option: ce })).toBe('only OPTIONS_BUY takes an option contract');
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY', option: { ...ce, underlyingStopPrice: 24900 } })).toBe(
      'an underlying stop needs both underlyingRef and underlyingStopPrice',
    );
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY', side: 'SELL', option: ce })).toBe('options are bought only');
    expect(err({ refPrice: 0 })).toBe('refPrice must be above 0');
    expect(err({ atr: -1 })).toBe('atr must be a number of 0 or more, or null');
  });
});

describe('armLevels (ruling L4)', () => {
  it('BUY: stop below, target and partial above the entry average; the partial quantity in whole lots', () => {
    expect(armLevels(adaptivePlan(), 500, 100, 1)).toEqual({ stopPrice: 494, targetPrice: 510, partialPrice: 505, partialQty: 50 });
  });

  it('SELL mirrors it', () => {
    expect(armLevels(cashPlan({ side: 'SELL' }), 500, 100, 1)).toEqual({ stopPrice: 507.5, targetPrice: 485, partialPrice: null, partialQty: 0 });
  });

  it('a partial that rounds to zero lots, or to everything, keeps its level but sells nothing', () => {
    expect(armLevels(adaptivePlan(), 500, 1, 1)).toMatchObject({ partialPrice: 505, partialQty: 0 });
    expect(armLevels(adaptivePlan(), 100, 75, 75)).toMatchObject({ partialQty: 0 });
  });

  it('options arm on the premium', () => {
    expect(armLevels(optionPlan(), 100, 75, 75)).toEqual({ stopPrice: 75, targetPrice: 150, partialPrice: null, partialQty: 0 });
  });

  it('rounds to the paisa', () => {
    expect(armLevels(cashPlan(), 333.33, 10, 1).stopPrice).toBe(328.33);
  });
});
