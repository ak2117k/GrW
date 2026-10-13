import { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import type { LedgerEntry } from '../execution/repositories/core-cash-ledger.repository';
import { cashPlan, mtfPlan, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import { outcomeOf, summarizeTrade } from './trade-summary';

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);
const D = '2026-10-13';

function ord(id: string, purpose: 'ENTRY' | 'EXIT', filledQty: number, avg: number, side: 'BUY' | 'SELL' = purpose === 'ENTRY' ? 'BUY' : 'SELL'): CoreOrder {
  return {
    id, userId: 'user_A', idempotencyKey: id, vehicle: 'CASH_INTRADAY', instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side, qty: filledQty, filledQty, avgFillPrice: avg, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: avg, purpose,
    strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null, submittedAt: ist(D, '10:00'), triggeredAt: null, updatedAt: ist(D, '10:00'),
  };
}

function led(type: LedgerEntry['type'], amount: string, orderId: string | null, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { id: `led_${Math.random()}`, userId: 'user_A', type, amount: new Prisma.Decimal(amount), orderId, fillId: null, token: '2885', interestDate: null, note: 't', createdAt: ist(D, '11:00'), ...over };
}

const closedLong = () =>
  positionFor(cashPlan(), {
    id: 'pos_1', intentId: 'ci_1', status: 'CLOSED', side: 'BUY', direction: 'LONG', requestedQty: 100, entryFilledQty: 100, exitFilledQty: 100, openQty: 0,
    entryAvgPrice: 500, initialStopPrice: 492.5, highWater: 516, lowWater: 497, openedAt: ist(D, '10:00'), closedAt: ist(D, '11:30'), exitReason: 'TARGET',
  });

const ORDERS = [ord('o1', 'ENTRY', 100, 500), ord('o2', 'EXIT', 50, 510), ord('o3', 'EXIT', 50, 515)];
const LEDGER = [
  led('REALISED_PNL', '500.00', 'o2'), led('REALISED_PNL', '750.00', 'o3'),
  led('CHARGES', '-20.00', 'o1'), led('CHARGES', '-11.00', 'o2'), led('CHARGES', '-12.00', 'o3'),
  led('CHARGES', '-99.00', 'o_other'), // another position's row: ignored
];

describe('summarizeTrade (spec §8.2, ruling J16)', () => {
  it('a long cash trade: gross, charges, net, R, MFE/MAE, holding time, exit price average', () => {
    const r = summarizeTrade({ position: closedLong(), orders: ORDERS, ledger: LEDGER });
    expect(r).toEqual({
      ok: true,
      summary: expect.objectContaining({
        positionId: 'pos_1', intentId: 'ci_1', qty: 100, side: 'BUY', entryAvgPrice: '500.0000', exitAvgPrice: '512.5000',
        grossPnl: '1250.00', charges: '43.00', mtfInterest: '0.00', netPnl: '1207.00',
        initialRisk: '750.00', rMultiple: '1.6093', mfePrice: '516.0000', maePrice: '497.0000', mfeRupees: '1600.00', maeRupees: '-300.00',
        holdMinutes: 90, exitReason: 'TARGET', istDay: '2026-10-13', exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ',
      }),
    });
  });

  it('a short trade: the best price is the low water mark', () => {
    const p = { ...closedLong(), side: 'SELL' as const, direction: 'SHORT' as const, highWater: 503, lowWater: 490 };
    const orders = [ord('o1', 'ENTRY', 100, 500, 'SELL'), ord('o2', 'EXIT', 100, 495, 'BUY')];
    const r = summarizeTrade({ position: p, orders, ledger: [led('REALISED_PNL', '500.00', 'o2')] });
    expect(r.ok && r.summary).toMatchObject({ mfePrice: '490.0000', maePrice: '503.0000', mfeRupees: '1000.00', maeRupees: '-300.00' });
  });

  it("MTF interest on the token over [open day, close day] is charged to the trade; a day before the open is not", () => {
    const p = { ...positionFor(mtfPlan(), {}), ...closedLong(), vehicle: 'MTF' as const, openedAt: ist('2026-10-12', '10:00'), closedAt: ist(D, '11:00') };
    const interest = [
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-11' }),
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-12' }),
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-13' }),
      led('MTF_INTEREST', '-9.00', null, { interestDate: '2026-10-12', token: '1594' }),
    ];
    const r = summarizeTrade({ position: p, orders: ORDERS, ledger: [...LEDGER, ...interest] });
    expect(r.ok && r.summary).toMatchObject({ mtfInterest: '51.00', netPnl: '1156.00' });
  });

  it('no initial stop → no R; refuses a position that is not CLOSED or whose exits do not add up', () => {
    const noStop = summarizeTrade({ position: { ...closedLong(), initialStopPrice: null }, orders: ORDERS, ledger: LEDGER });
    expect(noStop.ok && noStop.summary).toMatchObject({ initialRisk: null, rMultiple: null });
    expect(summarizeTrade({ position: { ...closedLong(), status: 'EXITING' }, orders: ORDERS, ledger: LEDGER })).toEqual({ ok: false, error: 'position pos_1 is EXITING, not CLOSED' });
    expect(summarizeTrade({ position: closedLong(), orders: ORDERS.slice(0, 2), ledger: LEDGER })).toEqual({ ok: false, error: 'exits filled 50 of the 100 entered' });
  });

  it('the corpus outcome in SP3 keys and numbers', () => {
    const r = summarizeTrade({ position: closedLong(), orders: ORDERS, ledger: LEDGER });
    if (!r.ok) throw new Error(r.error);
    expect(outcomeOf(r.summary)).toEqual({ netPnl: 1207, grossPnl: 1250, fees: 43, win: true, rMultiple: 1.6093, mfe: 1600, mae: -300, holdMins: 90 });
  });
});
