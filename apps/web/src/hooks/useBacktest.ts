import { useEffect, useCallback } from 'react';
import { useBacktestStore } from '@/stores/backtest-store';
import type { BacktestConfig } from '@/stores/backtest-store';

export function useBacktest() {
  const config = useBacktestStore((s) => s.config);
  const results = useBacktestStore((s) => s.results);
  const comparison = useBacktestStore((s) => s.comparison);
  const history = useBacktestStore((s) => s.history);
  const selectedRun = useBacktestStore((s) => s.selectedRun);
  const isRunning = useBacktestStore((s) => s.isRunning);
  const isLoadingHistory = useBacktestStore((s) => s.isLoadingHistory);
  const isCompareMode = useBacktestStore((s) => s.isCompareMode);
  const compareConfigs = useBacktestStore((s) => s.compareConfigs);

  const updateConfig = useBacktestStore((s) => s.updateConfig);
  const runBacktest = useBacktestStore((s) => s.runBacktest);
  const compareStrategies = useBacktestStore((s) => s.compareStrategies);
  const fetchHistory = useBacktestStore((s) => s.fetchHistory);
  const loadBacktest = useBacktestStore((s) => s.loadBacktest);
  const deleteBacktest = useBacktestStore((s) => s.deleteBacktest);
  const addToCompare = useBacktestStore((s) => s.addToCompare);
  const removeFromCompare = useBacktestStore((s) => s.removeFromCompare);
  const toggleCompareMode = useBacktestStore((s) => s.toggleCompareMode);
  const clearResults = useBacktestStore((s) => s.clearResults);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleRunBacktest = useCallback(() => {
    runBacktest();
  }, [runBacktest]);

  const handleCompare = useCallback(() => {
    compareStrategies();
  }, [compareStrategies]);

  const handleAddToCompare = useCallback(
    (cfg: BacktestConfig) => {
      addToCompare(cfg);
    },
    [addToCompare],
  );

  return {
    config,
    results,
    comparison,
    history,
    selectedRun,
    isRunning,
    isLoadingHistory,
    isCompareMode,
    compareConfigs,
    updateConfig,
    runBacktest: handleRunBacktest,
    compareStrategies: handleCompare,
    fetchHistory,
    loadBacktest,
    deleteBacktest,
    addToCompare: handleAddToCompare,
    removeFromCompare,
    toggleCompareMode,
    clearResults,
  };
}
