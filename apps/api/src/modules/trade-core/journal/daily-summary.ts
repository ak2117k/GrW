import { Prisma } from '@prisma/client';
import { ZERO } from '../execution/ledger-math';
import type { TradeSummary } from './journal.types';

const D = Prisma.Decimal;

/** Spec §8.4 daily summary. Costs = charges + MTF interest; their share of |gross| (null when gross is 0). */
export interface DailySummary {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: string | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  costsPctOfGross: string | null;
}

export function dailySummary(trades: readonly TradeSummary[]): DailySummary {
  let gross = ZERO;
  let costs = ZERO;
  let net = ZERO;
  let wins = 0;
  for (const t of trades) {
    gross = gross.plus(t.grossPnl);
    costs = costs.plus(t.charges).plus(t.mtfInterest);
    net = net.plus(t.netPnl);
    if (new D(t.netPnl).gt(0)) wins += 1;
  }
  const n = trades.length;
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRatePct: n > 0 ? ((wins / n) * 100).toFixed(1) : null,
    grossPnl: gross.toFixed(2),
    costs: costs.toFixed(2),
    netPnl: net.toFixed(2),
    costsPctOfGross: gross.isZero() ? null : costs.div(gross.abs()).mul(100).toFixed(1),
  };
}
