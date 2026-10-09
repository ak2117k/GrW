/**
 * SP2 building blocks (spec §4.1). A StrategyVersion is one value of
 * StrategyBlocks; validateBlocks() is the only gate a value passes before it is
 * stored or approved. Every *Pct field is a percent of price (1.5 = 1.5 %).
 *
 * Fields beyond the spec's original table (plan decision 4) exist because the
 * seeded silo code needs them: entry.match/side/minScore, the filters block,
 * trail.atr.{minPct,maxPct,startsAfter}, partial.atTarget1.atPct,
 * sizing.notionalRupees.
 */
export const VEHICLES = ['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'] as const;
export type Vehicle = (typeof VEHICLES)[number];

export const CANDLE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'] as const;
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];

export type EntrySide = 'BUY' | 'SELL' | 'BOTH';

export type EvaluatorParams = Record<string, number | string | boolean>;

/**
 * Gated admission: the alert's existing Chartink score (computed by the scoring
 * pipeline the silos share) must be at least `base`, or a window's `score` while
 * the time is inside that IST window [fromHhmm, toHhmm).
 *
 * Inside a window the window's `score` REPLACES `base` (it is not added to it,
 * nor is the higher of the two taken). The time tested is processing time (IST
 * now, when the alert is processed), not the alert's own timestamp, as in the
 * silo (trade-policy.ts:36-38, chartink-process.service.ts:383).
 */
export interface MinScore {
  base: number;
  windows: Array<{ fromHhmm: string; toHhmm: string; score: number }>;
}

/**
 * `chartink.match`: ANY admits every scan (`scanName` is null); EXACT and
 * CONTAINS compare the scan name to `scanName` case-insensitively (equality or
 * substring respectively), as the silo's isHullScanner lowercases.
 */
export type EntryBlock =
  | { kind: 'chartink'; scanName: string | null; match: 'ANY' | 'EXACT' | 'CONTAINS'; side: EntrySide; minScore: MinScore | null }
  | { kind: 'evaluator'; evaluatorKey: string; params: EvaluatorParams; side: EntrySide };

/** A named code evaluator used as a pass/fail entry gate (e.g. Adaptive-Stop's decision gate). */
export interface GateRef {
  kind: 'evaluator';
  evaluatorKey: string;
  params: EvaluatorParams;
}

/**
 * Entry filters (owner answer 3, 2026-10-09). Every rule is present; `null` (or
 * `[]` for gates) means "no such filter". Applied by the core before the Risk Wall.
 */
export interface FiltersBlock {
  /** Skip when the live price has already moved more than this % past the alert price, in the trade direction. */
  staleEntry: { maxMovePct: number } | null;
  /** Skip the same symbol for this many minutes after this strategy last entered it. */
  cooldown: { minutes: number } | null;
  /** Skip when this strategy's last closed trade on the symbol, today (IST), was a loss (net P&L ≤ 0). */
  lastLoss: { window: 'SAME_IST_DAY' } | null;
  /** Every gate must pass. */
  gates: GateRef[];
}

export type StopBlock =
  | { kind: 'fixedPct'; pct: number }
  | { kind: 'atr'; period: number; timeframe: CandleTimeframe; multiple: number; minPct: number; maxPct: number };

export type TargetBlock = { kind: 'fixedPct'; pct: number } | { kind: 'rr'; ratio: number };

/** An ATR trail reuses the ATR the stop block measured at entry. */
export type TrailBlock =
  | { kind: 'none' }
  | { kind: 'breakeven'; atPct: number }
  | { kind: 'atr'; multiple: number; minPct: number; maxPct: number; startsAfter: 'ENTRY' | 'PARTIAL' };

/** `hhmm` is IST wall-clock time, "HH:MM". */
export type TimeExitBlock = { kind: 'clock'; hhmm: string } | { kind: 'holdDays'; n: number };

/** `atPct` is the target-1 level the partial sells at. */
export type PartialBlock = { kind: 'none' } | { kind: 'atTarget1'; fraction: number; atPct: number };

/** Always capped by the Risk Wall (M2). */
export type SizingBlock = { kind: 'riskRupees'; amount: number } | { kind: 'notionalRupees'; amount: number };

export type VehicleBlock =
  | { kind: 'CASH_INTRADAY' }
  | { kind: 'MTF' }
  | {
      kind: 'OPTIONS_BUY';
      /** ATM, ITM1..ITM99, OTM1..OTM99 */
      strike: string;
      /** nearest expiry with at least this many days left */
      minDaysToExpiry: number;
      premiumStopPct: number;
      thetaStop: { minMovePct: number; withinMinutes: number };
      expiryDayExitHhmm: string;
    };

export interface StrategyBlocks {
  entry: EntryBlock;
  filters: FiltersBlock;
  stop: StopBlock;
  target: TargetBlock;
  trail: TrailBlock;
  timeExit: TimeExitBlock;
  partial: PartialBlock;
  sizing: SizingBlock;
  vehicle: VehicleBlock;
}

export const BLOCK_NAMES: readonly (keyof StrategyBlocks)[] = [
  'entry', 'filters', 'stop', 'target', 'trail', 'timeExit', 'partial', 'sizing', 'vehicle',
];

export interface BlockError {
  /** e.g. "stop.minPct", "blocks.leverage", "sizing" */
  path: string;
  message: string;
}
