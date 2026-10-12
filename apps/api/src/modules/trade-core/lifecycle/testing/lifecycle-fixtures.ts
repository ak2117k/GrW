import type { CoreOrder } from '../../execution/execution.types';

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
