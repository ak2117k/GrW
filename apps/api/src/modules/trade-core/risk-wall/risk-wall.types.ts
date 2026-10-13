import type { Vehicle } from '../strategies/blocks/block-types';
import type { DailyLossAction, LimitKey, LimitScope } from './limits/limit-keys';

export type Direction = 'LONG' | 'SHORT';
export type LimitSource = 'USER' | 'USER_SETTINGS' | 'DEFAULT';

/**
 * An entry the core wants to make (spec §3: alert/evaluator → CoreEntryIntent →
 * RiskWall.check). M2 fixes the fields the wall reads; M5 builds the intent (Chartink
 * fan-out and evaluators) using M3's vehicle model for capitalPerUnit and lotSize.
 */
export interface CoreEntryIntent {
  kind: 'ENTRY';
  /** Unique per intent: the M5 journal key and the root of M3's order idempotency key. */
  intentId: string;
  userId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  /** NSE for CASH_INTRADAY and MTF, NFO for OPTIONS_BUY (VEHICLE_EXCHANGES). */
  exchange: string;
  /** The traded symbol: the equity, or the option contract. */
  symbol: string;
  /** The equity the exposure is on (equal to symbol for cash and MTF). */
  underlying: string;
  side: 'BUY' | 'SELL';
  /** CE or PE for OPTIONS_BUY, else null. A bought PE is SHORT the underlying. */
  optionType: 'CE' | 'PE' | null;
  /** Requested quantity in units (shares, or option units), a whole multiple of lotSize. */
  qty: number;
  /** 1 for cash and MTF; the contract lot size for options. */
  lotSize: number;
  /** ₹ per unit the size was computed from (the premium for options). */
  refPrice: number;
  /** The producer's freshness verdict for refPrice (hub / execution threshold, spec §6.3). */
  refPriceFresh: boolean;
  /** The initial stop in refPrice units; null when the strategy has none (rejected: risk unknown). */
  stopPrice: number | null;
  /** ₹ of capital one unit blocks under M3's vehicle model: cash = price ÷ leverage, MTF = own share, options = premium. */
  capitalPerUnit: number;
  /** MTF only: notional ÷ own funds. Null for the other vehicles. */
  mtfLeverage: number | null;
}

/** Exits are never checked (spec §5.1); the type exists so an exit that reaches the wall passes visibly. */
export interface CoreExitIntent {
  kind: 'EXIT';
  intentId: string;
  userId: string;
  positionId: string;
  qty: number;
}

export type CoreIntent = CoreEntryIntent | CoreExitIntent;

export type CorePositionState = 'PENDING_ENTRY' | 'OPEN' | 'PARTIAL' | 'EXITING';

/** One open or pending core position as M4's lifecycle reports it. */
export interface RiskOpenPosition {
  positionId: string;
  strategyId: string;
  vehicle: Vehicle;
  symbol: string;
  underlying: string;
  direction: Direction;
  state: CorePositionState;
  /** Has a fresh price now (M4/hub rule). Any unpriced position blocks entries (parent §7.1). */
  priced: boolean;
}

/**
 * The user's live state (spec §5.1), provided through RISK_STATE_PROVIDER by M3 (cash
 * ledger, deployed capital) and M4 (positions, P&L). Rupees are net of charges; a
 * null means "cannot compute" and the wall rejects.
 */
export interface RiskLiveState {
  asOf: Date;
  /** Every core position of the user in PENDING_ENTRY | OPEN | PARTIAL | EXITING. */
  openPositions: readonly RiskOpenPosition[];
  /** Today's (IST) realised P&L, ₹. */
  realisedPnlToday: number;
  /** Mark-to-market P&L of the open positions, ₹; null when it cannot be computed. */
  openPnl: number | null;
  /** Today's realised + open P&L per strategyId, ₹; a strategy absent here has 0 today. */
  pnlTodayByStrategy: Readonly<Record<string, number>>;
  /** Entries placed today (IST). */
  tradesToday: number;
  /** ₹ of capital blocked per vehicle (open positions + pending entries); null = unknown. */
  deployedCapital: Readonly<Record<Vehicle, number | null>>;
  /** The daily loss limit was reached earlier this session (spec §5.3: blocked for the rest of it). */
  dailyLossLatched: boolean;
  /**
   * SP2 M5 (J12, O10): unacknowledged reconciliation findings. Absent = none (M2–M4 providers).
   * `all` blocks every strategy of the user; otherwise only the listed strategies. Entries only.
   */
  reconBlocked?: { all: boolean; strategyIds: readonly string[] };
  /**
   * SP2 M5: the journal-derived inputs (latch, recon block) could not be read. Entries fail
   * closed (JOURNAL_UNAVAILABLE); the provider does not throw, so DailyLossMonitor still decides
   * on P&L and a journal outage never stops a square-off. Absent = readable.
   */
  journalUnreadable?: boolean;
}

/** One limit in force as the wall used it: the journal's limits snapshot. */
export interface LimitInForce {
  key: LimitKey;
  scope: LimitScope;
  /** Canonical value: "5000.00", "10", "2.00", "15:00", "BLOCK_ENTRIES". */
  value: string;
  rowId: string;
  effectiveFrom: string;
  source: LimitSource;
}

export interface RiskContext {
  now: Date;
  limits: readonly LimitInForce[];
  killSwitchActive: boolean;
  /** SessionClock.isOpen(intent.exchange, now). */
  sessionOpen: boolean;
  state: RiskLiveState;
}

export const RISK_REASON_CODES = [
  'WITHIN_LIMITS',
  'EXIT_NOT_CHECKED',
  'INVALID_INTENT',
  'KILL_SWITCH',
  'LIMIT_MISSING',
  'SESSION_CLOSED',
  'STALE_PRICE',
  'UNPRICED_POSITION',
  'PNL_UNKNOWN',
  'STATE_UNKNOWN',
  'DAILY_LOSS',
  'STRATEGY_DAILY_LOSS',
  'MAX_TRADES',
  'MAX_OPEN_POSITIONS',
  'MAX_OPEN_POSITIONS_VEHICLE',
  'CONFLICT_SAME_SYMBOL',
  'CONFLICT_OPPOSITE_DIRECTION',
  'AFTER_LAST_ENTRY',
  'AFTER_SQUARE_OFF',
  'VEHICLE_SIDE',
  'MTF_LEVERAGE',
  'RISK_UNKNOWN',
  'CAP_RISK_PER_TRADE',
  'CAP_CAPITAL_DEPLOYED',
  'CAP_OPTIONS_PREMIUM',
  'CONTEXT_UNAVAILABLE',
  'JOURNAL_UNAVAILABLE',
  'RECON_BLOCKED',
] as const;
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];

export interface RiskReason {
  code: RiskReasonCode;
  message: string;
}

export type RiskVerdictKind = 'ALLOW' | 'REJECT' | 'RESIZE';

/** Spec §5.3. squareOffCore tells M4 to exit every core position (CORE_SQUARE_OFF, cause DAILY_LOSS). */
export interface DailyLossDecision {
  status: 'OK' | 'BREACHED' | 'UNKNOWN';
  /** 2 dp; positive = loss, negative = profit. Null when P&L is unknown, except a BREACHED decided on
   *  the realised loss alone with open P&L unknown (owner ruling 2026-10-12): then the realised loss. */
  lossRupees: string | null;
  limitRupees: string | null;
  action: DailyLossAction | null;
  squareOffCore: boolean;
}

export interface RiskStateSnapshot {
  asOf: string;
  realisedPnlToday: string | null;
  openPnl: string | null;
  tradesToday: number;
  openPositions: number;
  openPositionsByVehicle: Record<Vehicle, number>;
  deployedCapital: Record<Vehicle, string | null>;
  dailyLossLatched: boolean;
}

/** Everything M5's RISK_VERDICT journal row needs (spec §5.1, §8.1). */
export interface RiskVerdict {
  intentId: string;
  userId: string;
  intentKind: 'ENTRY' | 'EXIT';
  verdict: RiskVerdictKind;
  requestedQty: number;
  /** ALLOW = requested; RESIZE = less than requested and at least one lot; REJECT = 0. */
  qty: number;
  reasons: RiskReason[];
  /** The limits snapshot used (empty when the context could not be loaded, and for exits). */
  limits: LimitInForce[];
  state: RiskStateSnapshot | null;
  dailyLoss: DailyLossDecision | null;
  killSwitchActive: boolean | null;
  checkedAt: string;
}
