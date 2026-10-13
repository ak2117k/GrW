import { Prisma } from '@prisma/client';
import type { CoreOrder, LedgerType } from '../execution/execution.types';
import { istDate, ZERO } from '../execution/ledger-math';
import type { LedgerEntry } from '../execution/repositories/core-cash-ledger.repository';
import { round2 } from '../lifecycle/exit-plan';
import type { CorePosition } from '../lifecycle/lifecycle.types';
import type { CorpusOutcome, NewTradeSummary, TradeSummary } from './journal.types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export interface SummaryInput {
  position: CorePosition;
  /** The position's own orders (core_orders.positionId). */
  orders: readonly CoreOrder[];
  /** Ledger rows of those orders plus MTF_INTEREST rows on the token (PaperLedgerService.ledgerRowsForPosition). */
  ledger: readonly LedgerEntry[];
}

export type SummaryResult = { ok: true; summary: NewTradeSummary } | { ok: false; error: string };

const fail = (error: string): SummaryResult => ({ ok: false, error });
const sumOf = (rows: readonly LedgerEntry[], type: LedgerType): Dec => rows.filter((r) => r.type === type).reduce((a, r) => a.plus(r.amount), ZERO);

/**
 * Spec §8.2 / ruling J16. Ledger signs (M3): REALISED_PNL is signed, CHARGES and MTF_INTEREST are
 * negative, so charges = −ΣCHARGES and interest = −ΣMTF_INTEREST are costs ≥ 0. MFE/MAE use the
 * best and worst prices the lifecycle saw (M4 highWater/lowWater) against the entry average.
 */
export function summarizeTrade(i: SummaryInput): SummaryResult {
  const p = i.position;
  if (p.status !== 'CLOSED') return fail(`position ${p.id} is ${p.status}, not CLOSED`);
  if (p.entryAvgPrice === null || p.openedAt === null || p.closedAt === null || p.exitReason === null) {
    return fail(`closed position ${p.id} lacks its entry price, open or close time, or exit reason`);
  }
  const qty = p.entryFilledQty;
  const exits = i.orders.filter((o) => o.purpose === 'EXIT' && o.filledQty > 0);
  const exitQty = exits.reduce((n, o) => n + o.filledQty, 0);
  if (qty <= 0 || exitQty !== qty) return fail(`exits filled ${exitQty} of the ${qty} entered`);
  if (exits.some((o) => o.avgFillPrice === null)) return fail('an exit fill has no average price');
  const exitAvg = exits.reduce((a, o) => a.plus(new D(o.avgFillPrice as number).mul(o.filledQty)), ZERO).div(exitQty);

  const own = new Set(i.orders.map((o) => o.id));
  const rows = i.ledger.filter((r) => r.orderId !== null && own.has(r.orderId));
  const gross = sumOf(rows, 'REALISED_PNL');
  const charges = ZERO.minus(sumOf(rows, 'CHARGES'));
  const fromDay = istDate(p.openedAt);
  const toDay = istDate(p.closedAt);
  const interestRows = i.ledger.filter((r) => r.token === p.instrument.token && r.interestDate !== null && r.interestDate >= fromDay && r.interestDate <= toDay);
  const interest = ZERO.minus(sumOf(interestRows, 'MTF_INTEREST'));
  const net = gross.minus(charges).minus(interest);

  const entry = new D(p.entryAvgPrice);
  const dir = p.side === 'BUY' ? 1 : -1;
  const risk = p.initialStopPrice === null ? null : entry.minus(p.initialStopPrice).abs().mul(qty);
  const usableRisk = risk !== null && risk.gt(0) ? risk : null;
  const best = p.side === 'BUY' ? p.highWater : p.lowWater;
  const worst = p.side === 'BUY' ? p.lowWater : p.highWater;
  const rupees = (px: number | null): string | null => (px === null ? null : new D(px).minus(entry).mul(qty * dir).toFixed(2));

  return {
    ok: true,
    summary: {
      userId: p.userId,
      positionId: p.id,
      intentId: p.intentId,
      strategyId: p.strategyId,
      strategyVersionId: p.strategyVersionId,
      vehicle: p.vehicle,
      exchange: p.instrument.exchange,
      token: p.instrument.token,
      symbol: p.instrument.symbol,
      side: p.side,
      qty,
      entryAvgPrice: entry.toFixed(4),
      exitAvgPrice: exitAvg.toFixed(4),
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      grossPnl: gross.toFixed(2),
      charges: charges.toFixed(2),
      mtfInterest: interest.toFixed(2),
      netPnl: net.toFixed(2),
      initialRisk: usableRisk ? usableRisk.toFixed(2) : null,
      rMultiple: usableRisk ? net.div(usableRisk).toFixed(4) : null,
      mfePrice: best === null ? null : new D(best).toFixed(4),
      maePrice: worst === null ? null : new D(worst).toFixed(4),
      mfeRupees: rupees(best),
      maeRupees: rupees(worst),
      holdMinutes: Math.max(0, Math.floor((p.closedAt.getTime() - p.openedAt.getTime()) / 60_000)),
      exitReason: p.exitReason,
      istDay: istDate(p.closedAt),
    },
  };
}

/** SP3 spec §5.1 outcome keys (rupees as numbers). */
export function outcomeOf(s: TradeSummary | NewTradeSummary): CorpusOutcome {
  const n = (x: string | null): number | null => (x === null ? null : Number(x));
  return {
    netPnl: Number(s.netPnl),
    grossPnl: Number(s.grossPnl),
    fees: round2(Number(s.charges) + Number(s.mtfInterest)),
    win: Number(s.netPnl) > 0,
    rMultiple: n(s.rMultiple),
    mfe: n(s.mfeRupees),
    mae: n(s.maeRupees),
    holdMins: s.holdMinutes,
  };
}
