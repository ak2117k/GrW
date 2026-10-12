import type { ChargeBreakdown, LegSide, Segment } from '../../trade-sentinel/charges';
import type { Vehicle } from '../strategies/blocks/block-types';

/**
 * SP2 M3 execution contracts (spec §4.2). Strategies and the lifecycle (M4/M5) write
 * against ExecutionAdapter; SP7 swaps in a live adapter. Prices on the request and the
 * order are rupees as numbers with at most 2 decimals (avgFillPrice 4); ledger money is
 * Prisma.Decimal inside the services and 2-dp strings on the views.
 */
export const ORDER_STATES = ['NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL_MARKET'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export type OrderSide = 'BUY' | 'SELL';
export type OrderPurpose = 'ENTRY' | 'EXIT';

export const LEDGER_TYPES = ['DEPOSIT', 'MARGIN_BLOCK', 'MARGIN_RELEASE', 'REALISED_PNL', 'CHARGES', 'MTF_INTEREST'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** A resolved contract (spec §3: the strike/expiry picker is M4/M5; the adapter takes what it is given). */
export interface CoreInstrument {
  exchange: string;
  token: string;
  symbol: string;
  /** 1 for cash and MTF; the contract lot size for options. */
  lotSize: number;
  /** Options: the index or stock the contract is on (maxLotsPerOrder is keyed by it). Null for cash and MTF. */
  underlying: string | null;
}

export interface CoreOrderRequest {
  userId: string;
  /** Unique across all orders; derived from CoreEntryIntent.intentId or the exit intent. */
  idempotencyKey: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  side: OrderSide;
  /** Units (shares, or option units), a whole multiple of instrument.lotSize. */
  qty: number;
  type: OrderType;
  /** LIMIT only. */
  limitPrice: number | null;
  /** SL_MARKET only. */
  triggerPrice: number | null;
  /** ₹ per unit a MARKET or SL_MARKET entry blocks margin at (the intent's refPrice). LIMIT blocks at its limit. */
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
  /** SP2 M4: the core position this order belongs to; absent or null outside the lifecycle. */
  positionId?: string | null;
}

/** What modify may change on an open order. */
export interface CoreOrderPatch {
  qty?: number;
  limitPrice?: number;
  triggerPrice?: number;
}

export interface CoreOrder {
  id: string;
  userId: string;
  idempotencyKey: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  side: OrderSide;
  qty: number;
  filledQty: number;
  avgFillPrice: number | null;
  type: OrderType;
  limitPrice: number | null;
  triggerPrice: number | null;
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
  /** SP2 M4: the owning core position, or null. */
  positionId?: string | null;
  state: OrderState;
  rejectReason: string | null;
  submittedAt: Date;
  /**
   * SL_MARKET only (ruling P10): when a fresh price first reached the trigger. Once set the
   * stop never un-triggers and fills as MARKET. Null for other types and untriggered stops.
   */
  triggeredAt: Date | null;
  updatedAt: Date;
}

/** The JSON stored on a fill: the per-leg breakdown plus the MTF pledge fee. `total` includes the fee. */
export interface FillCharges extends ChargeBreakdown {
  segment: Segment;
  leg: LegSide;
  pledgeFee: number;
}

/** A non-flat position on one (vehicle, token), derived from fills. */
export interface CorePositionView {
  /** `${vehicle}:${token}` */
  key: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  /** Signed: positive long, negative short. */
  netQty: number;
  direction: 'LONG' | 'SHORT';
  /** 4 dp. */
  avgPrice: string;
  /** Gross realised P&L booked on this key so far, 2 dp. */
  realisedPnl: string;
  /** Margin the position holds, 2 dp. */
  blockedMargin: string;
  openedAt: Date;
}

/** The user's paper money (spec §4.4), every figure a 2-dp string. */
export interface CoreFunds {
  userId: string;
  deposited: string;
  realisedPnl: string;
  charges: string;
  mtfInterest: string;
  /** deposited + realisedPnl − charges − mtfInterest */
  cash: string;
  blockedMargin: string;
  /** cash − blockedMargin = the sum of every ledger row */
  freeCash: string;
  /** Margin held per vehicle: open positions plus the unfilled qty of open entry orders. */
  deployedByVehicle: Record<Vehicle, string>;
}

/**
 * Spec §4.2, with userId on the calls that name an existing order (plan ruling 1:
 * every core_* query is scoped to its user).
 */
export interface ExecutionAdapter {
  /** Idempotent on req.idempotencyKey. */
  placeOrder(req: CoreOrderRequest): Promise<CoreOrder>;
  cancel(userId: string, orderId: string): Promise<CoreOrder>;
  modify(userId: string, orderId: string, patch: CoreOrderPatch): Promise<CoreOrder>;
  getOrder(userId: string, orderId: string): Promise<CoreOrder>;
  getPositions(userId: string): Promise<CorePositionView[]>;
  getFunds(userId: string): Promise<CoreFunds>;
  /**
   * SP2 M4 (drift D2): every committed change of any core order (placement, fill, trigger,
   * modify, cancel, reject). Returns the unsubscribe. A live adapter (SP7) feeds it from
   * broker order updates.
   */
  onOrderUpdate(listener: (order: CoreOrder) => void): () => void;
  /** SP2 M4: the user's orders of one core position, oldest first. */
  listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]>;
}
