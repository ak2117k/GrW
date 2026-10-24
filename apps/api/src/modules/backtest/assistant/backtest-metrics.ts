/**
 * Aggregates of a backtest for the results panel and the summary prompt. Only these numbers ever
 * reach the model — never raw bars or the trade list.
 */
import type { BacktestTrade } from '../../../common/interfaces/trading-strategy.interface';

export interface YearRow {
  year: number;
  trades: number;
  winRate: number;
  pnl: number;
  pnlAfterCosts: number;
}

export interface BacktestAggregates {
  trades: number;
  longs: number;
  shorts: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  netPnl: number;
  returnPct: number;
  estCosts: number;
  netAfterCosts: number;
  returnAfterCostsPct: number;
  profitFactorAfterCosts: number | null;
  expectancy: number;
  expectancyAfterCosts: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPct: number;
  maxDrawdownAfterCostsPct: number;
  avgHoldHours: number;
  costBpsPerSide: number;
  exitReasons: Record<string, number>;
  byYear: YearRow[];
  firstTrade: string | null;
  lastTrade: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `positionSizePct` and the capital walk replicate StrategyExecutorService exactly (qty =
 * floor(capital × pct / 100 / entry), capital += pnl), so per-trade notional — and therefore the
 * cost estimate — matches what the engine traded. Costs: `costBpsPerSide` of notional on entry and
 * on exit (brokerage + STT + exchange + slippage, a rough flat proxy).
 */
export function computeAggregates(
  trades: BacktestTrade[],
  initialCapital: number,
  positionSizePct: number,
  costBpsPerSide: number,
): BacktestAggregates {
  let capital = initialCapital;
  let equity = initialCapital;
  let equityNet = initialCapital;
  let peak = initialCapital;
  let peakNet = initialCapital;
  let maxDd = 0;
  let maxDdNet = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let gpNet = 0;
  let glNet = 0;
  let wins = 0;
  let estCosts = 0;
  let holdMs = 0;
  const exitReasons: Record<string, number> = {};
  const years = new Map<number, YearRow>();

  for (const t of trades) {
    const entryTime = new Date(t.entryTime);
    const exitTime = new Date(t.exitTime);
    const qty = Math.floor((capital * positionSizePct) / 100 / t.entryPrice);
    const cost = ((t.entryPrice + t.exitPrice) * Math.max(qty, 0) * costBpsPerSide) / 10_000;
    const net = t.pnl - cost;
    capital += t.pnl;
    estCosts += cost;
    if (t.pnl > 0) { wins++; grossProfit += t.pnl; } else grossLoss += -t.pnl;
    if (net > 0) gpNet += net; else glNet += -net;
    equity += t.pnl;
    equityNet += net;
    peak = Math.max(peak, equity);
    peakNet = Math.max(peakNet, equityNet);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
    maxDdNet = Math.max(maxDdNet, peakNet > 0 ? (peakNet - equityNet) / peakNet : 0);
    holdMs += Math.max(0, exitTime.getTime() - entryTime.getTime());
    exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;
    const y = exitTime.getUTCFullYear();
    const row = years.get(y) ?? { year: y, trades: 0, winRate: 0, pnl: 0, pnlAfterCosts: 0 };
    row.trades++;
    row.winRate += t.pnl > 0 ? 1 : 0; // count for now, converted below
    row.pnl += t.pnl;
    row.pnlAfterCosts += net;
    years.set(y, row);
  }

  const n = trades.length;
  const netPnl = grossProfit - grossLoss;
  const losses = n - wins;
  return {
    trades: n,
    longs: trades.filter((t) => t.side === 'BUY').length,
    shorts: trades.filter((t) => t.side === 'SELL').length,
    wins,
    losses,
    winRate: n ? r2((wins / n) * 100) : 0,
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : null,
    netPnl: r2(netPnl),
    returnPct: r2((netPnl / initialCapital) * 100),
    estCosts: r2(estCosts),
    netAfterCosts: r2(netPnl - estCosts),
    returnAfterCostsPct: r2(((netPnl - estCosts) / initialCapital) * 100),
    profitFactorAfterCosts: glNet > 0 ? r2(gpNet / glNet) : null,
    expectancy: n ? r2(netPnl / n) : 0,
    expectancyAfterCosts: n ? r2((netPnl - estCosts) / n) : 0,
    avgWin: wins ? r2(grossProfit / wins) : 0,
    avgLoss: losses ? r2(grossLoss / losses) : 0,
    maxDrawdownPct: r2(maxDd * 100),
    maxDrawdownAfterCostsPct: r2(maxDdNet * 100),
    avgHoldHours: n ? r2(holdMs / n / 3_600_000) : 0,
    costBpsPerSide,
    exitReasons,
    byYear: [...years.values()]
      .sort((a, b) => a.year - b.year)
      .map((y) => ({ ...y, winRate: r2((y.winRate / y.trades) * 100), pnl: r2(y.pnl), pnlAfterCosts: r2(y.pnlAfterCosts) })),
    firstTrade: n ? new Date(trades[0].entryTime).toISOString() : null,
    lastTrade: n ? new Date(trades[n - 1].exitTime).toISOString() : null,
  };
}
