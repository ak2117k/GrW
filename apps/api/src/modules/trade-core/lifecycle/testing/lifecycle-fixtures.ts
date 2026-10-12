import type { CoreOrder } from '../../execution/execution.types';
import { limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import { adaptiveBlocks, plainBlocks } from '../../strategies/testing/block-fixtures';
import { armLevels, buildExitPlan, type PlanInput } from '../exit-plan';
import type { CorePosition, ExitPlan } from '../lifecycle.types';

/** Test data only. Mon 2026-10-12 10:30 IST (the M2/M3 fixtures' NOW). */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

let seq = 0;

/** `positionId` joins CoreOrder in Task 6; the intersection keeps this file typechecking before and after. */
type LifecycleOrder = CoreOrder & { positionId?: string | null };

/** A cash BUY entry order of position pos_1, open and unfilled unless overridden. */
export function order(over: Partial<LifecycleOrder> = {}): LifecycleOrder {
  seq += 1;
  return {
    id: `ord_${seq}`,
    userId: 'user_A',
    idempotencyKey: `int_1:k${seq}`,
    vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY',
    qty: 100,
    filledQty: 0,
    avgFillPrice: null,
    type: 'MARKET',
    limitPrice: null,
    triggerPrice: null,
    refPrice: 500,
    purpose: 'ENTRY',
    strategyVersionId: 'csv_ungated_v1',
    state: 'OPEN',
    rejectReason: null,
    submittedAt: NOW,
    triggeredAt: null,
    updatedAt: NOW,
    positionId: 'pos_1',
    ...over,
  };
}

export function mtfBlocks(): StrategyBlocks {
  return { ...plainBlocks(), vehicle: { kind: 'MTF' }, timeExit: { kind: 'holdDays', n: 3 } };
}

/** A NIFTY CE buyer: 30 % stop on the premium, capped by the 25 % premium stop; 50 % target. */
export function optionBlocks(): StrategyBlocks {
  return {
    ...plainBlocks(),
    stop: { kind: 'fixedPct', pct: 30 },
    target: { kind: 'fixedPct', pct: 50 },
    timeExit: { kind: 'clock', hhmm: '15:00' },
    vehicle: {
      kind: 'OPTIONS_BUY',
      strike: 'ATM',
      minDaysToExpiry: 2,
      premiumStopPct: 25,
      thetaStop: { minMovePct: 10, withinMinutes: 30 },
      expiryDayExitHhmm: '14:30',
    },
  };
}

function planOf(input: Partial<PlanInput> & Pick<PlanInput, 'blocks' | 'vehicle'>, over: Partial<ExitPlan>): ExitPlan {
  const r = buildExitPlan({ side: 'BUY', refPrice: 500, atr: null, limits: limitsFixture(), option: null, now: NOW, ...input });
  if (!r.ok) throw new Error(r.error);
  return { ...r.plan, ...over };
}

/** Ungated-shaped cash plan: stop 1.5 %, target 3 %, no trail, clock exit 15:25, square-off 15:15. */
export const cashPlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: plainBlocks(), vehicle: 'CASH_INTRADAY' }, over);
/** Adaptive-shaped cash plan with ATR 5 at a 500 reference: stop 1.2 %, target 2 %, half at +1 %, ATR trail after it. */
export const adaptivePlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: adaptiveBlocks(), vehicle: 'CASH_INTRADAY', atr: 5 }, over);
/** MTF: stop 1.5 %, target 3 %, time exit after 3 trading days, hold limit 10, square-off 15:20. */
export const mtfPlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: mtfBlocks(), vehicle: 'MTF' }, over);
/** CE at a 100 premium expiring Thu 2026-10-15: stop 25 %, target 50 %, theta 10 % in 30 min, out by 14:30 on expiry day. */
export const optionPlan = (over: Partial<ExitPlan> = {}): ExitPlan =>
  planOf(
    {
      blocks: optionBlocks(),
      vehicle: 'OPTIONS_BUY',
      refPrice: 100,
      option: { optionType: 'CE', expiry: '2026-10-15', underlyingRef: null, underlyingStopPrice: null },
    },
    over,
  );

/** An OPEN position under `plan`: cash 100 @ 500, or options 75 (one lot) @ 100; opened 10 minutes before NOW. */
export function positionFor(plan: ExitPlan, over: Partial<CorePosition> = {}): CorePosition {
  const option = plan.vehicle === 'OPTIONS_BUY';
  const entry = option ? 100 : 500;
  const qty = option ? 75 : 100;
  const lv = armLevels(plan, entry, qty, option ? 75 : 1);
  return {
    id: 'pos_1',
    userId: 'user_A',
    intentId: 'int_1',
    strategyId: 'cs_ungated',
    strategyVersionId: 'csv_ungated_v1',
    vehicle: plan.vehicle,
    instrument: option
      ? { exchange: 'NFO', token: '43210', symbol: 'NIFTY26OCT25000CE', lotSize: 75, underlying: 'NIFTY' }
      : { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    underlying: option ? 'NIFTY' : 'RELIANCE',
    side: plan.side,
    direction: plan.side === 'BUY' ? 'LONG' : 'SHORT',
    status: 'OPEN',
    requestedQty: qty,
    entryFilledQty: qty,
    exitFilledQty: 0,
    openQty: qty,
    entryAvgPrice: entry,
    plan,
    initialStopPrice: lv.stopPrice,
    stopPrice: lv.stopPrice,
    targetPrice: lv.targetPrice,
    partialPrice: lv.partialPrice,
    partialQty: lv.partialQty,
    trailActive: false,
    partialDone: false,
    highWater: entry,
    lowWater: entry,
    exitSeq: 0,
    exitReason: null,
    blindSince: null,
    openedAt: new Date(NOW.getTime() - 10 * 60_000),
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...over,
  };
}
