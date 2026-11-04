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

/**
 * FLOOR_HARD_EXIT: a FIXED reference point of the position — the contract price, the underlying at
 * that moment (null when it was not readable then) and when. A `type` so the packet stays Prisma JSON.
 */
export type PriceAnchor = { ltp: number; underlying: number | null; at: string };
/**
 * `money.anchors.best` / `.floorArm` in the sentinel packet: the position's best point (the premium's
 * high-water mark, low for a short) and the point the green floor armed. Set by the trade-sentinel
 * cycle; neither ever moves to a later verdict's price — that re-anchoring is the 2026-10-29 bug.
 */
export type FloorAnchors = { best: PriceAnchor | null; floorArm: PriceAnchor | null };

/**
 * The noise-vs-real opinion an exit decision point may take (owner 2026-11-04: "the engine identifies
 * noise and chooses the exit"). The plug for a future classifier: TODAY NOTHING SUPPLIES ONE — every
 * caller passes null — and null / UNKNOWN means exactly the code rules (lock-green floor break, spike
 * bank, the ₹2k band's K·N underlying test). Where a decision point honours it is documented on it.
 */
export type NoiseVerdict = 'NOISE' | 'REAL' | 'UNKNOWN';
export type NoiseOpinion = { verdict: NoiseVerdict; p?: number; source: string };

export type ClauseId =
  | 'THESIS_INVALIDATION' | 'THESIS_LEVEL'
  | 'HARD_MAX_LOSS' | 'HARD_SESSION_CLOSE' | 'HARD_EXPIRY' | 'HARD_DAILY_LOSS'
  | 'FLOOR_BREACH_UNDERLYING_MOVE' | 'FLOOR_BREACH_VWAP'
  | 'FLOOR_HARD_GREEN_TO_RED' | 'FLOOR_HARD_UNDERLYING_MOVE' | 'FLOOR_HARD_GREEN_LOCK'
  | 'TARGET_LADDER';
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
export type Justification = 'THESIS_BROKEN' | 'HARD_RISK' | 'CONFIRMED_FLOOR_BREACH' | 'FLOOR_HARD_EXIT' | 'TARGET_LADDER';

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
  /**
   * Minutes before the exchange close that the broker squares off an INTRADAY (MIS) position
   * (INTRADAY_CARRY_SQUARE_OFF_LEAD_MIN, e.g. NFO 15 → 15:15). HARD_SESSION_CLOSE counts to that
   * deadline, not the exchange close. Absent/null ⇒ 0 (the exchange close, as before).
   */
  squareOffLeadMin?: number | null;
  productType: string | null;
  isExpiryDay: boolean;
  dailyLossLatched: boolean;
  /** Minutes since the position's session opened (null/absent when unknown: the opening guard is skipped). */
  minutesSinceOpen?: number | null;
  /**
   * FLOOR_HARD_EXIT, from a packet that carries `money.anchors`: the underlying at the position's best
   * point and at the floor's arm point, and the two reads of premium and net P&L (the packet's and the
   * executor's fresh one) the hard-floor clauses both require. Absent ⇒ a pre-anchor packet: the
   * legacy since-the-last-HOLD frame and no hard-floor clauses, exactly as before.
   */
  anchors?: { bestUnderlying: number | null; armUnderlying: number | null; packetLtp: number; packetNetPnl: number | null; freshNetPnl: number | null };
  /**
   * TARGET_LADDER (target-ladder.ts), from a packet whose `money.ladder` is enforced: the ladder's stop and
   * stage, whether the last target was reached, and the packet's premium (the stop clause needs it AND the
   * executor's fresh one beyond the stop). Absent ⇒ no ladder clause, exactly as before.
   */
  ladder?: { stop: number | null; stage: number; lastHit: boolean; packetLtp: number };
  /**
   * The packet thesis's source (2026-11-04, spec D8/D10): INFERRED = a manual trade whose thesis the model
   * guessed; USER = recorded by the platform or corrected by the user. With
   * GATE_INFERRED_THESIS_RECORD_ONLY on, an INFERRED thesis's THESIS_INVALIDATION / THESIS_LEVEL are
   * record-only. Absent / null ⇒ exactly as before.
   */
  thesisSource?: ThesisSource | null;
}

export type ThesisSource = 'INFERRED' | 'USER';

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
  /** Set when a non-hard-risk exit was held because the session opened less than openingGuardMin ago. */
  openingGuard?: { minutesSinceOpen: number; guardMin: number };
  /**
   * MBM M3 (MBM_EXIT_SHADOW observe|on, MBM-mapped positions only): what an MBM-sized trail would
   * have looked like beside this decision (sentinel-executor/domain/mbm-exit-shadow.ts). A record,
   * never an input — absent with the flag off, so off-records are unchanged.
   */
  mbmShadow?: { v: 1; usable: boolean; [k: string]: unknown };
}

export type OutcomeKind = 'EXECUTED' | 'DRY_RUN' | 'GATED' | 'AWAITING';
