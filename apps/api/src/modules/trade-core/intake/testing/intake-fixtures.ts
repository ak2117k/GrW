import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import { plainBlocks } from '../../strategies/testing/block-fixtures';
import type { ChartinkHit } from '../alert-handoff';

/** IST wall-clock → Date (test data). */
export const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000+05:30`);

/** Tue 2026-10-13 10:30 IST, a Hull scan BUY on RELIANCE at 500, score 70. */
export function hit(over: Partial<ChartinkHit> = {}): ChartinkHit {
  return {
    alertId: 'alert_1',
    symbol: 'RELIANCE',
    tradingSymbol: 'RELIANCE-EQ',
    token: '2885',
    exchange: 'NSE',
    hitPrice: 500,
    scanName: 'Hull MA cross 15m',
    side: 'BUY',
    score: 70,
    receivedAt: ist('2026-10-13', '10:30'),
    alertAt: ist('2026-10-13', '10:30'),
    ...over,
  };
}

/** Exactly the M1 seed csv_adaptive_stop_v1 blocks (20261009120000_sp2_m1_strategy_catalogue), full gate params. */
export function adaptiveSeedBlocks(): StrategyBlocks {
  return {
    entry: { kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY', minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] } },
    filters: {
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: 45 },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [
        {
          kind: 'evaluator',
          evaluatorKey: 'adaptive-stop-decision-gate',
          params: { nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5, requireMacdBullish: true, srLookbackDays: 5, minCandles: 10, minSameDayCandles: 3, failOpen: true },
        },
      ],
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

export { plainBlocks };
