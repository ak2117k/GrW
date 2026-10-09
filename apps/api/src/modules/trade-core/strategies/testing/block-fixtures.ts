import type { StrategyBlocks } from '../blocks/block-types';

/**
 * Test data only, not seeds. Seeds are rows in the M1 migration
 * (core-strategy-seeds.spec.ts checks them).
 */

/** Adaptive-Stop-shaped: score gate, all filters, ATR stop, a partial at +1 %, then an ATR trail. */
export function adaptiveBlocks(): StrategyBlocks {
  return {
    entry: {
      kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
      minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] },
    },
    filters: {
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: 45 },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [{ kind: 'evaluator', evaluatorKey: 'adaptive-stop-decision-gate', params: { nearSupportPct: 0.6, rsiHot: 70 } }],
    },
    stop: { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 },
    target: { kind: 'fixedPct', pct: 2 },
    trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
    timeExit: { kind: 'clock', hhmm: '15:15' },
    partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
    sizing: { kind: 'riskRupees', amount: 800 },
    vehicle: { kind: 'CASH_INTRADAY' },
  };
}

/** Ungated-shaped: no score gate, no gates, fixed stop and target, pure hold. */
export function plainBlocks(): StrategyBlocks {
  return {
    entry: { kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null },
    filters: { staleEntry: { maxMovePct: 1 }, cooldown: { minutes: 45 }, lastLoss: { window: 'SAME_IST_DAY' }, gates: [] },
    stop: { kind: 'fixedPct', pct: 1.5 },
    target: { kind: 'fixedPct', pct: 3 },
    trail: { kind: 'none' },
    timeExit: { kind: 'clock', hhmm: '15:25' },
    partial: { kind: 'none' },
    sizing: { kind: 'notionalRupees', amount: 200000 },
    vehicle: { kind: 'CASH_INTRADAY' },
  };
}
