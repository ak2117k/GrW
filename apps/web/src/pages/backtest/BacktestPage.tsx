import { useState, useMemo } from 'react';
import {
  FlaskConical,
  History,
  Trash2,
  GitCompareArrows,
  X,
  ChevronRight,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useBacktest } from '@/hooks/useBacktest';
import BacktestConfig from '@/components/trading/BacktestConfig';
import BacktestResults from '@/components/trading/BacktestResults';
import BacktestTradeList from '@/components/trading/BacktestTradeList';
import BacktestEquityCurve from '@/components/charts/BacktestEquityCurve';
import { LoadingSkeleton } from '@/components/common';
import AIInsightCard from '@/components/ai/AIInsightCard';
import { StrategyChat } from '@/components/strategy/StrategyChat';
import type { BacktestConfig as BacktestConfigType } from '@/stores/backtest-store';

/**
 * Stable fingerprint of a backtest run — used as the insight contextKey
 * so re-asking for a review on the same (config, result) returns the
 * cached markdown instead of re-queueing.
 */
function fingerprintRun(
  config: BacktestConfigType,
  totalTrades: number,
  totalReturn: number,
): string {
  const core = `${config.strategy}|${config.symbol}|${config.timeframe}|${config.startDate}|${config.endDate}|${totalTrades}|${totalReturn.toFixed(0)}`;
  let h = 5381;
  for (let i = 0; i < core.length; i++) {
    h = ((h << 5) + h + core.charCodeAt(i)) | 0;
  }
  return `bt-${Math.abs(h).toString(36)}`;
}

function formatINR(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function BacktestPage() {
  const {
    config,
    results,
    comparison,
    history,
    isRunning,
    isLoadingHistory,
    isCompareMode,
    compareConfigs,
    updateConfig,
    runBacktest,
    compareStrategies,
    loadBacktest,
    deleteBacktest,
    addToCompare,
    removeFromCompare,
    toggleCompareMode,
  } = useBacktest();

  const [showHistory, setShowHistory] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // Snapshot for the chat drawer — covers current config + any active
  // results/comparison so Claude can answer questions in full context.
  const chatSnapshot = useMemo(
    () => ({
      page: 'backtest',
      config,
      results: results
        ? {
            totalTrades: results.totalTrades,
            winRate: results.winRate,
            totalReturn: results.totalReturn,
            totalReturnPercent: results.totalReturnPercent,
            maxDrawdown: results.maxDrawdown,
            sharpeRatio: results.sharpeRatio,
            // Cap trades list to avoid huge payloads.
            sampleTrades: results.trades.slice(0, 20),
          }
        : null,
      comparison: comparison
        ? {
            strategies: comparison.results.map((r) => ({
              strategy: r.strategy,
              totalTrades: r.totalTrades,
              winRate: r.winRate,
              totalReturn: r.totalReturn,
              totalReturnPercent: r.totalReturnPercent,
              maxDrawdown: r.maxDrawdown,
              sharpeRatio: r.sharpeRatio,
            })),
          }
        : null,
    }),
    [config, results, comparison],
  );

  // Context for the AI review card — only meaningful after a run completes.
  const reviewContext = useMemo(() => {
    if (!results) return null;
    const contextKey = fingerprintRun(config, results.totalTrades, results.totalReturn);
    const contextData = {
      config,
      results: {
        totalTrades: results.totalTrades,
        winRate: results.winRate,
        totalReturn: results.totalReturn,
        totalReturnPercent: results.totalReturnPercent,
        maxDrawdown: results.maxDrawdown,
        sharpeRatio: results.sharpeRatio,
        sampleTrades: results.trades.slice(0, 30),
      },
    };
    return { contextKey, contextData };
  }, [config, results]);

  function handleSubmit(_cfg: BacktestConfigType) {
    runBacktest();
  }

  function handleAddToCompare(cfg: BacktestConfigType) {
    addToCompare({ ...cfg });
  }

  const hasResults = results !== null;
  const hasComparison = comparison !== null && comparison.results.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical size={24} className="text-[var(--color-accent-yellow)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Backtest
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleCompareMode}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-all',
              isCompareMode
                ? 'border-[var(--color-accent-yellow)] bg-[var(--color-accent-yellow)]/10 text-[var(--color-accent-yellow)]'
                : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            <GitCompareArrows size={14} />
            Compare Mode
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-all',
              showHistory
                ? 'border-[var(--color-accent-blue)] bg-[var(--color-accent-blue)]/10 text-[var(--color-accent-blue)]'
                : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            <History size={14} />
            History
          </button>
          <button
            onClick={() => setChatOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-accent-purple,#a78bfa)]/40 bg-[var(--color-accent-purple,#a78bfa)]/10 px-3 py-2 text-xs font-medium text-[var(--color-accent-purple,#a78bfa)] hover:bg-[var(--color-accent-purple,#a78bfa)]/20 transition-colors"
            title="Open chat with Claude"
          >
            <MessageSquare size={14} />
            Ask Claude
          </button>
        </div>
      </div>

      {/* Compare mode chips */}
      {isCompareMode && compareConfigs.length > 0 && (
        <div className="rounded-lg border border-[var(--color-accent-yellow)]/30 bg-[var(--color-accent-yellow)]/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-accent-yellow)]">
              Strategies to compare ({compareConfigs.length}/5)
            </span>
            <button
              onClick={compareStrategies}
              disabled={compareConfigs.length < 2 || isRunning}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition-all',
                compareConfigs.length >= 2 && !isRunning
                  ? 'bg-[var(--color-accent-yellow)] text-black hover:brightness-110'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-not-allowed',
              )}
            >
              Run Comparison
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {compareConfigs.map((cfg, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1 text-xs"
              >
                <span className="text-[var(--color-text-primary)] font-medium">
                  {cfg.strategy}
                </span>
                <span className="text-[var(--color-text-muted)]">
                  {cfg.symbol} / {cfg.timeframe}
                </span>
                <button
                  onClick={() => removeFromCompare(i)}
                  className="ml-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)] transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main layout: Config + Results */}
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Left panel: Configuration */}
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
          <h2 className="mb-4 text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
            Configuration
          </h2>
          <BacktestConfig
            config={config}
            onConfigChange={updateConfig}
            onSubmit={handleSubmit}
            onAddToCompare={handleAddToCompare}
            isRunning={isRunning}
            isCompareMode={isCompareMode}
          />
        </div>

        {/* Right panel: Results */}
        <div className="space-y-6">
          {isRunning && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6">
              <LoadingSkeleton variant="text" height="24px" className="mb-4" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 8 }, (_, i) => (
                  <LoadingSkeleton key={i} variant="card" height="80px" />
                ))}
              </div>
            </div>
          )}

          {!isRunning && hasComparison && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
              <BacktestResults
                results={comparison.results[0]}
                comparison={comparison.results}
              />
            </div>
          )}

          {!isRunning && hasResults && !hasComparison && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
              <BacktestResults results={results} />
            </div>
          )}

          {!isRunning && hasResults && !hasComparison && reviewContext && (
            <AIInsightCard
              sectionKey="backtest-review"
              contextKey={reviewContext.contextKey}
              contextData={reviewContext.contextData}
              title="Claude's Backtest Review"
            />
          )}

          {!isRunning && !hasResults && !hasComparison && (
            <div className="flex h-64 items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
              <div className="text-center">
                <FlaskConical
                  size={40}
                  className="mx-auto mb-3 text-[var(--color-text-muted)]"
                />
                <p className="text-sm text-[var(--color-text-muted)]">
                  Configure a strategy and run a backtest to see results
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Equity Curve + Trade List (below main layout) */}
      {!isRunning && hasComparison && (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
          <BacktestEquityCurve
            trades={comparison.results[0].trades}
            initialCapital={config.initialCapital}
            comparison={comparison.results.map((r) => ({
              strategy: r.strategy,
              trades: r.trades,
              initialCapital: config.initialCapital,
            }))}
          />
        </div>
      )}

      {!isRunning && hasResults && !hasComparison && (
        <>
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
            <BacktestEquityCurve
              trades={results.trades}
              initialCapital={config.initialCapital}
            />
          </div>

          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
            <BacktestTradeList trades={results.trades} />
          </div>
        </>
      )}

      {/* History section */}
      {showHistory && (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
            Backtest History
          </h2>

          {isLoadingHistory && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <LoadingSkeleton key={i} variant="card" height="140px" />
              ))}
            </div>
          )}

          {!isLoadingHistory && history.length === 0 && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 text-center">
              <p className="text-sm text-[var(--color-text-muted)]">
                No past backtest runs found
              </p>
            </div>
          )}

          {!isLoadingHistory && history.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {history.map((run) => {
                const isProfitable = run.totalReturn > 0;
                return (
                  <div
                    key={run.id}
                    className="group relative rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4 transition-all hover:border-[var(--color-border-default)] cursor-pointer"
                    onClick={() => loadBacktest(run.id)}
                  >
                    {/* Delete button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBacktest(run.id);
                      }}
                      className="absolute right-2 top-2 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-accent-red)]/10 hover:text-[var(--color-accent-red)] group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>

                    {/* Strategy name */}
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                        {run.strategy}
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>

                    {/* Symbol + Timeframe */}
                    <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                      {run.parameters?.symbol ?? '?'} / {run.parameters?.timeframe ?? '?'}
                      {' -- '}
                      {formatDate(run.startDate)} to {formatDate(run.endDate)}
                    </p>

                    {/* Quick stats */}
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-[10px] text-[var(--color-text-muted)]">Return</p>
                        <p
                          className={cn(
                            'text-xs font-bold tabular-nums',
                            isProfitable
                              ? 'text-[var(--color-accent-green)]'
                              : 'text-[var(--color-accent-red)]',
                          )}
                        >
                          {formatINR(run.totalReturn)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--color-text-muted)]">Win Rate</p>
                        <p className="text-xs font-bold text-[var(--color-text-primary)] tabular-nums">
                          {run.winRate.toFixed(1)}%
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--color-text-muted)]">Trades</p>
                        <p className="text-xs font-bold text-[var(--color-text-primary)] tabular-nums">
                          {run.totalTrades}
                        </p>
                      </div>
                    </div>

                    {/* Date */}
                    <p className="mt-3 text-[10px] text-[var(--color-text-muted)]">
                      Run on {formatDate(run.createdAt)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Chat drawer for backtest-specific questions */}
      <StrategyChat
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        sectionKey="backtest-chat"
        title="Backtest Chat"
        placeholder="Ask about this backtest — config, results, what to tune..."
        snapshot={chatSnapshot}
      />
    </div>
  );
}
