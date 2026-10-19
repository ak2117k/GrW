export type PositionSide = 'LONG' | 'SHORT';
/** The direction the UNDERLYING must move to help the position. */
export type Exposure = 'BULLISH' | 'BEARISH';

/** One 1-minute bar; `ts` = bar start, ms epoch (HubCandle without volume/oi). */
export interface MinuteBar { ts: number; open: number; high: number; low: number; close: number }

/** 'atr14-15m-scaled' is legacy (mis-scaled daily ATR) — kept so stored packets still parse. */
export type NoiseMethod = 'atr14-1m' | 'range-sqrt-1m' | 'atr14-daily-scaled' | 'atr14-15m-scaled';
export interface NoiseReading { n: number; method: NoiseMethod; bars: number; at: string }

/**
 * `flow.noiseUnit.value` in the sentinel packet. WIRE CONTRACT: written by
 * trade-sentinel, read by sentinel-executor and the replay engine.
 * `contract` is on the contract's own scale (premium); `underlying` on the underlying's.
 */
export interface NoiseUnitValue { contract: NoiseReading | null; underlying: NoiseReading | null }

/** `money.floorBasis`: how money.greenFloorPrice was set. Missing in pre-v7 packets ⇒ 'fixed'. */
export type FloorBasis = 'noise' | 'fixed';
export interface NoiseFloor { basis: 'noise'; armed: boolean; level: number; armPrice: number; n: number }

export type ClauseId =
  | 'THESIS_INVALIDATION' | 'THESIS_LEVEL'
  | 'HARD_MAX_LOSS' | 'HARD_SESSION_CLOSE' | 'HARD_EXPIRY' | 'HARD_DAILY_LOSS'
  | 'FLOOR_BREACH_UNDERLYING_MOVE' | 'FLOOR_BREACH_VWAP';
/** `pass: null` = could not be measured (an input was missing). */
export interface ClauseResult {
  id: ClauseId;
  pass: boolean | null;
  measured: Record<string, number | string | boolean | null>;
  note: string;
}

export interface PersistenceResult {
  confirmed: boolean;
  rule: 'BYPASS' | 'CONSECUTIVE' | 'SUSTAINED' | null;
  previous: { id: string; verdict: string; ageSec: number } | null;
  streakStart: { id: string; ageSec: number } | null;
}

export type GateOutcome = 'PASS' | 'GATED_THESIS_INTACT' | 'AWAITING_CONFIRMATION' | 'BYPASS';
export type Justification = 'THESIS_BROKEN' | 'HARD_RISK' | 'CONFIRMED_FLOOR_BREACH';

/** The numbers the gate judged, copied onto the row (E7). */
export interface GateFactsSnapshot {
  exposure: Exposure | null;
  positionSide: PositionSide;
  ltpNow: number;
  underlying: number | null;
  invalidation: number | null;
  holdRef: { id: string; underlying: number | null; support: number | null; resistance: number | null; at: string } | null;
  vwap: number | null;
  nContract: number | null;
  nUnderlying: number | null;
  floor: { price: number | null; armed: boolean; basis: FloorBasis };
  netPnlNow: number | null;
  maxLossPerTrade: number | null;
  minutesToClose: number | null;
  productType: string | null;
  isExpiryDay: boolean;
  dailyLossLatched: boolean;
}

/** `ai_exit_executions.gate` (E7). */
export interface GateRecordV1 {
  v: 1;
  outcome: GateOutcome;
  bypassReason?: 'DISABLED' | 'FACTS_UNREADABLE';
  error?: string;
  justification: Justification | null;
  clauses: ClauseResult[];
  persistence: PersistenceResult | null;
  facts: GateFactsSnapshot | null;
  cfg: { floorArmN: number; floorTrailN: number; gateCloseMin: number; gateUnderlyingN: number; persistWindowSec: number; persistMinSec: number };
  evaluatedAt: string;
  /**
   * MBM M3 (MBM_EXIT_SHADOW observe|on, MBM-mapped positions only): what an MBM-sized trail would
   * have looked like beside this decision (sentinel-executor/domain/mbm-exit-shadow.ts). A record,
   * never an input — absent with the flag off, so off-records are unchanged.
   */
  mbmShadow?: { v: 1; usable: boolean; [k: string]: unknown };
}

export type OutcomeKind = 'EXECUTED' | 'DRY_RUN' | 'GATED' | 'AWAITING';
