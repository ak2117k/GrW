import type { HubExchange } from '../../market-hub/hub.types';
import type { CoreInstrument, OrderSide } from '../execution/execution.types';
import type { CorePositionState, Direction } from '../risk-wall/risk-wall.types';
import type { PartialBlock, TimeExitBlock, TrailBlock, Vehicle } from '../strategies/blocks/block-types';

/**
 * SP2 M4 lifecycle contracts (spec §7). A core position is one entry intent's life:
 * PENDING_ENTRY → OPEN → PARTIAL → EXITING → CLOSED, or → CANCELLED when nothing of the
 * entry filled. Quantities come from the position's own core_orders (reducePosition);
 * the row keeps the plan frozen at entry and the marks the rules need.
 */
export type CorePositionStatus = CorePositionState | 'CLOSED' | 'CANCELLED';

export const POSITION_STATUSES: readonly CorePositionStatus[] = ['PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED'];
export const ACTIVE_STATUSES: readonly CorePositionState[] = ['PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING'];

export function isActiveStatus(s: string): s is CorePositionState {
  return (ACTIVE_STATUSES as readonly string[]).includes(s);
}

export const EXIT_REASONS = [
  'KILL_SWITCH',
  'DAILY_LOSS',
  'STOP',
  'GAP_STOP',
  'RECOVERY_STOP',
  'UNDERLYING_STOP',
  'GUARD_RAIL',
  'MANUAL',
  'TARGET',
  'TRAIL',
  'TIME_EXIT',
  'THETA_STOP',
  'EXPIRY_DAY',
  'HOLD_LIMIT',
  'SQUARE_OFF',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Spec §7.3: lower runs first. GUARD_RAIL and MANUAL are explicit requests ranked with the stop. */
export const EXIT_PRIORITY: Readonly<Record<ExitReason, number>> = {
  KILL_SWITCH: 1,
  DAILY_LOSS: 2,
  STOP: 3,
  GAP_STOP: 3,
  RECOVERY_STOP: 3,
  UNDERLYING_STOP: 3,
  GUARD_RAIL: 3,
  MANUAL: 3,
  TARGET: 4,
  TRAIL: 5,
  TIME_EXIT: 6,
  THETA_STOP: 6,
  EXPIRY_DAY: 6,
  HOLD_LIMIT: 6,
  SQUARE_OFF: 7,
};

/** A later decision replaces the recorded reason only when it ranks strictly higher. */
export function outranks(next: ExitReason, current: ExitReason | null): boolean {
  return current === null || EXIT_PRIORITY[next] < EXIT_PRIORITY[current];
}

/** Order idempotency keys (M3 notes: entries are `${intentId}:entry`). */
export const entryKey = (intentId: string): string => `${intentId}:entry`;
export const exitKey = (intentId: string, seq: number): string => `${intentId}:exit:${seq}`;

export interface UnderlyingRef {
  exchange: HubExchange;
  token: string;
  symbol: string;
}

/** OPTIONS_BUY rules frozen at entry (spec §7.5; owner decision O3: premium-based). */
export interface OptionPlan {
  optionType: 'CE' | 'PE';
  /** IST date, YYYY-MM-DD. */
  expiry: string;
  premiumStopPct: number;
  thetaStop: { minMovePct: number; withinMinutes: number };
  expiryDayExitHhmm: string;
  /** Present only with underlyingStopPrice: the underlying is watched at priority 1. */
  underlyingRef: UnderlyingRef | null;
  underlyingStopPrice: number | null;
}

/** The exit rules frozen at entry (spec §7.1). Percent fields are percent of price. */
export interface ExitPlan {
  version: 1;
  vehicle: Vehicle;
  /** The entry side; exits use the opposite side. */
  side: OrderSide;
  /** Initial stop distance from the entry average, %. */
  stopPct: number;
  /** Target distance from the entry average, %. */
  targetPct: number;
  trail: TrailBlock;
  partial: PartialBlock;
  timeExit: TimeExitBlock;
  /** ATR measured at entry, in price units (the stop and the ATR trail use it); null when none. */
  atr: number | null;
  /** squareOffTime@vehicle from the verdict's limits snapshot (HH:MM IST). */
  squareOffHhmm: string;
  /** mtfMaxHoldDays from the snapshot; null for other vehicles. */
  mtfMaxHoldDays: number | null;
  /** IST date the position was opened. */
  entryDay: string;
  option: OptionPlan | null;
}

export interface CorePosition {
  id: string;
  userId: string;
  /** Unique; the corpus sourceId for source 'core' (ruling L13). */
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  /** The exposure underlying the Risk Wall compares (the intent's underlying). */
  underlying: string;
  side: OrderSide;
  direction: Direction;
  status: CorePositionStatus;
  requestedQty: number;
  entryFilledQty: number;
  exitFilledQty: number;
  /** entryFilledQty − exitFilledQty. */
  openQty: number;
  entryAvgPrice: number | null;
  plan: ExitPlan;
  initialStopPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  partialPrice: number | null;
  partialQty: number;
  trailActive: boolean;
  partialDone: boolean;
  /** Best and worst traded price seen while open (MFE / MAE for M5). */
  highWater: number | null;
  lowWater: number | null;
  /** The last exit sequence claimed (0 = none). */
  exitSeq: number;
  exitReason: ExitReason | null;
  blindSince: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface NewPositionRow {
  userId: string;
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  underlying: string;
  side: OrderSide;
  direction: Direction;
  requestedQty: number;
  plan: ExitPlan;
}

export type PositionPatch = Partial<
  Pick<
    CorePosition,
    | 'status'
    | 'entryFilledQty'
    | 'exitFilledQty'
    | 'entryAvgPrice'
    | 'initialStopPrice'
    | 'stopPrice'
    | 'targetPrice'
    | 'partialPrice'
    | 'partialQty'
    | 'trailActive'
    | 'partialDone'
    | 'highWater'
    | 'lowWater'
    | 'exitSeq'
    | 'exitReason'
    | 'blindSince'
    | 'openedAt'
    | 'closedAt'
  >
>;

/** Spec §8.1 journal types the lifecycle produces (M5 persists them; ruling L12). */
export const LIFECYCLE_EVENT_TYPES = ['POSITION_STATE', 'STOP_MOVED', 'EXIT_DECIDED', 'BLIND', 'RECOVERY_STOP'] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleEvent {
  type: LifecycleEventType;
  userId: string;
  positionId: string;
  strategyVersionId: string;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  at: Date;
}
