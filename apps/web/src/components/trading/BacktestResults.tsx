import { cn } from '@/utils/cn';
import type { BacktestResultData } from '@/stores/backtest-store';

interface BacktestResultsProps {
  results: BacktestResultData;
  comparison?: Array<BacktestResultData & { strategy: string }>;
}

function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function computeExtras(results: BacktestResultData) {
  const winningTrades = results.trades.filter((t) => t.pnl > 0);
  const losingTrades = results.trades.filter((t) => t.pnl < 0);

  const avgProfit =
    winningTrades.length > 0
      ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length
      : 0;

  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((s, t) => s + t.pnl, 0) / losingTrades.length
      : 0;

  const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return { avgProfit, avgLoss, profitFactor };
}

interface MetricCardProps {
  label: string;
  value: string;
  isPositive?: boolean | null;
  subtitle?: string;
}

function MetricCard({ label, value, isPositive, subtitle }: MetricCardProps) {
  const colorClass =
    isPositive === true
      ? 'text-[var(--color-accent-green)]'
      : isPositive === false
        ? 'text-[var(--color-accent-red)]'
        : 'text-[var(--color-text-primary)]';

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] p-3">
      <p className="text-xs text-[var(--color-text-muted)] mb-1">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums', colorClass)}>{value}</p>
      {subtitle && (
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>
      )}
    </div>
  );
}

function ResultMetrics({ results, label }: { results: BacktestResultData; label?: string }) {
  const { avgProfit, avgLoss, profitFactor } = computeExtras(results);
  const isProfitable = results.totalReturn > 0;

  return (
    <div>
      {label && (
        <h4 className="mb-3 text-sm font-semibold text-[var(--color-accent-blue)]">{label}</h4>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          label="Total Return"
          value={formatINR(results.totalReturn)}
          isPositive={isProfitable}
          subtitle={formatPercent(results.totalReturnPercent)}
        />
        <MetricCard
          label="Win Rate"
          value={`${results.winRate.toFixed(1)}%`}
          isPositive={results.winRate >= 50}
        />
        <MetricCard
          label="Total Trades"
          value={String(results.totalTrades)}
          isPositive={null}
        />
        <MetricCard
          label="Max Drawdown"
          value={`${results.maxDrawdown.toFixed(2)}%`}
          isPositive={results.maxDrawdown < 10 ? true : false}
        />
        <MetricCard
          label="Avg Profit / Trade"
          value={formatINR(avgProfit)}
          isPositive={avgProfit > 0}
        />
        <MetricCard
          label="Avg Loss / Trade"
          value={formatINR(avgLoss)}
          isPositive={false}
        />
        <MetricCard
          label="Sharpe Ratio"
          value={results.sharpeRatio.toFixed(2)}
          isPositive={results.sharpeRatio > 1 ? true : results.sharpeRatio < 0 ? false : null}
        />
        <MetricCard
          label="Profit Factor"
          value={profitFactor === Infinity ? 'INF' : profitFactor.toFixed(2)}
          isPositive={profitFactor > 1 ? true : profitFactor < 1 ? false : null}
        />
      </div>
    </div>
  );
}

export default function BacktestResults({ results, comparison }: BacktestResultsProps) {
  // Comparison mode: show side-by-side
  if (comparison && comparison.length > 0) {
    return (
      <div className="space-y-6">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
          Strategy Comparison
        </h3>

        {/* Summary comparison table */}
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]">
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-text-muted)]">
                  Metric
                </th>
                {comparison.map((r, i) => (
                  <th
                    key={i}
                    className="px-3 py-2 text-right text-xs font-medium text-[var(--color-accent-blue)]"
                  >
                    {r.strategy}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                {
                  label: 'Total Return',
                  values: comparison.map((r) => formatINR(r.totalReturn)),
                  positive: comparison.map((r) => r.totalReturn > 0),
                },
                {
                  label: 'Return %',
                  values: comparison.map((r) => formatPercent(r.totalReturnPercent)),
                  positive: comparison.map((r) => r.totalReturnPercent > 0),
                },
                {
                  label: 'Win Rate',
                  values: comparison.map((r) => `${r.winRate.toFixed(1)}%`),
                  positive: comparison.map((r) => r.winRate >= 50),
                },
                {
                  label: 'Total Trades',
                  values: comparison.map((r) => String(r.totalTrades)),
                  positive: comparison.map(() => null as boolean | null),
                },
                {
                  label: 'Max Drawdown',
                  values: comparison.map((r) => `${r.maxDrawdown.toFixed(2)}%`),
                  positive: comparison.map((r) => r.maxDrawdown < 10),
                },
                {
                  label: 'Sharpe Ratio',
                  values: comparison.map((r) => r.sharpeRatio.toFixed(2)),
                  positive: comparison.map((r) =>
                    r.sharpeRatio > 1 ? true : r.sharpeRatio < 0 ? false : null,
                  ),
                },
              ].map((row) => (
                <tr
                  key={row.label}
                  className="border-b border-[var(--color-border-subtle)]/50"
                >
                  <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                    {row.label}
                  </td>
                  {row.values.map((val, i) => {
                    const pos = row.positive[i];
                    return (
                      <td
                        key={i}
                        className={cn(
                          'px-3 py-2 text-right font-medium tabular-nums',
                          pos === true
                            ? 'text-[var(--color-accent-green)]'
                            : pos === false
                              ? 'text-[var(--color-accent-red)]'
                              : 'text-[var(--color-text-primary)]',
                        )}
                      >
                        {val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Individual detail sections */}
        {comparison.map((r, i) => (
          <ResultMetrics key={i} results={r} label={r.strategy} />
        ))}
      </div>
    );
  }

  // Single result mode
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
          Performance Metrics
        </h3>
        <span
          className={cn(
            'rounded-full px-3 py-1 text-xs font-semibold',
            results.totalReturn > 0
              ? 'bg-[var(--color-accent-green)]/15 text-[var(--color-accent-green)]'
              : 'bg-[var(--color-accent-red)]/15 text-[var(--color-accent-red)]',
          )}
        >
          {results.totalReturn > 0 ? 'Profitable' : 'Unprofitable'}
        </span>
      </div>
      <ResultMetrics results={results} />
    </div>
  );
}
