import { useState, useMemo } from 'react';
import { useTrades } from '@/hooks/useTrades';
import { useAutoTrade } from '@/hooks/useAutoTrade';
import { useTradeStore } from '@/stores/trade-store';
import {
  AutoTradeControls,
  KillSwitchButton,
  RiskStatusBar,
  PositionRow,
  TradeExecutionLog,
  TradeCard,
  ExecuteTradeModal,
} from '@/components/trading';
import { StatCard, LoadingSkeleton, EmptyState } from '@/components/common';
import { TradeStatus } from '@/types';
import {
  Bot,
  Plus,
  TrendingUp,
  BarChart3,
  Target,
  CircleDot,
  Scan,
  Clock,
  Check,
  X,
  Zap,
  AlertCircle,
} from 'lucide-react';

export default function AutoTradePage() {
  const { openTrades, positions, recentTrades, isLoading } = useTrades();
  const {
    status: autoTradeStatus,
    pendingApprovals,
    isLoading: autoTradeLoading,
    approveSignal,
    rejectSignal,
    forceExecute,
    triggerScan,
  } = useAutoTrade();
  const closeTrade = useTradeStore((s) => s.closeTrade);

  const [showTradeModal, setShowTradeModal] = useState(false);

  // Stats calculations
  const todayPnl = useMemo(() => {
    const total = positions.reduce((sum, p) => sum + p.pnl, 0);
    const closedToday = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
    return total + closedToday;
  }, [positions, recentTrades]);

  const totalTradesToday = openTrades.length + recentTrades.length;

  const winRate = useMemo(() => {
    const closed = recentTrades.filter(
      (t) => t.status === TradeStatus.CLOSED || t.status === TradeStatus.FILLED,
    );
    if (closed.length === 0) return 0;
    const wins = closed.filter((t) => t.pnl > 0).length;
    return Math.round((wins / closed.length) * 100);
  }, [recentTrades]);

  const closedTradesLast10 = recentTrades.slice(0, 10);

  const handleClosePosition = (symbol: string) => {
    const trade = openTrades.find((t) => t.symbol === symbol);
    if (trade) {
      closeTrade(trade.id);
    }
  };

  const lastScanTime = autoTradeStatus.lastScanStats?.timestamp
    ? new Date(autoTradeStatus.lastScanStats.timestamp).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="space-y-5">
      {/* Top bar: Controls + Kill Switch */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Bot size={24} className="text-[var(--color-accent-green)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Auto-Trade</h1>
          {autoTradeStatus.isRunning && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              RUNNING
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => triggerScan()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            <Scan size={14} />
            Scan Now
          </button>
          <AutoTradeControls />
          <KillSwitchButton />
        </div>
      </div>

      {/* Risk Status Bar */}
      <RiskStatusBar />

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="Today's P&L"
          value={`${todayPnl >= 0 ? '+' : ''}${todayPnl.toLocaleString('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0,
          })}`}
          trend={todayPnl > 0 ? 'up' : todayPnl < 0 ? 'down' : 'flat'}
          icon={<TrendingUp size={16} />}
        />
        <StatCard
          title="Total Trades"
          value={totalTradesToday}
          icon={<BarChart3 size={16} />}
        />
        <StatCard
          title="Win Rate"
          value={`${winRate}%`}
          trend={winRate >= 50 ? 'up' : winRate > 0 ? 'down' : 'flat'}
          icon={<Target size={16} />}
        />
        <StatCard
          title="Active Positions"
          value={positions.length}
          icon={<CircleDot size={16} />}
        />
      </div>

      {/* Last Scan Stats */}
      {autoTradeStatus.lastScanStats?.timestamp && (
        <div className="flex items-center gap-4 px-4 py-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text-muted)]">
          <div className="flex items-center gap-1.5">
            <Clock size={12} />
            <span>Last scan: {lastScanTime}</span>
          </div>
          <span>Processed: {autoTradeStatus.lastScanStats.processed}</span>
          <span className="text-emerald-400">Executed: {autoTradeStatus.lastScanStats.executed}</span>
          <span className="text-amber-400">Pending: {autoTradeStatus.lastScanStats.pending}</span>
          <span>Skipped: {autoTradeStatus.lastScanStats.skipped}</span>
          {autoTradeStatus.lastScanStats.errors > 0 && (
            <span className="text-red-400">Errors: {autoTradeStatus.lastScanStats.errors}</span>
          )}
        </div>
      )}

      {/* Pending Approvals */}
      {pendingApprovals.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20">
            <AlertCircle size={14} className="text-amber-400" />
            <span className="text-sm font-semibold text-amber-300">
              Pending Approvals
            </span>
            <span className="text-[10px] text-amber-400/70 ml-auto">
              {pendingApprovals.length} signal{pendingApprovals.length > 1 ? 's' : ''} awaiting approval
            </span>
          </div>
          <div className="divide-y divide-amber-500/10">
            {pendingApprovals.map((approval) => (
              <div
                key={approval.signalId}
                className="flex items-center gap-4 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">
                      {approval.symbol}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-1.5 rounded ${
                        approval.side === 'BUY'
                          ? 'text-emerald-400 bg-emerald-400/10'
                          : 'text-red-400 bg-red-400/10'
                      }`}
                    >
                      {approval.side}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      x{approval.quantity}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      @{approval.entryPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                    <span>Strategy: {approval.strategy}</span>
                    <span>Confidence: {approval.confidenceScore}%</span>
                    <span>
                      Target: {approval.targetPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span>
                      SL: {approval.stoplossPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => approveSignal(approval.signalId)}
                    disabled={autoTradeLoading}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
                  >
                    <Check size={12} />
                    Approve
                  </button>
                  <button
                    onClick={() => rejectSignal(approval.signalId)}
                    disabled={autoTradeLoading}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors disabled:opacity-50"
                  >
                    <X size={12} />
                    Reject
                  </button>
                  <button
                    onClick={() => forceExecute(approval.signalId)}
                    disabled={autoTradeLoading}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-50"
                    title="Force execute immediately"
                  >
                    <Zap size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main content: Two columns */}
      <div className="flex gap-4" style={{ minHeight: '400px' }}>
        {/* Left: Open Positions (60%) */}
        <div className="flex-[3] min-w-0 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border-subtle)]">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Open Positions
              {positions.length > 0 && (
                <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
                  ({positions.length})
                </span>
              )}
            </h2>
          </div>

          {isLoading ? (
            <div className="p-4 space-y-2">
              <LoadingSkeleton variant="table-row" count={3} />
            </div>
          ) : positions.length === 0 ? (
            <EmptyState
              title="No open positions"
              description="Execute a trade to see positions here"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    <th className="px-4 py-2 font-medium">Symbol</th>
                    <th className="px-4 py-2 font-medium">Side</th>
                    <th className="px-4 py-2 font-medium text-right">Qty</th>
                    <th className="px-4 py-2 font-medium text-right">Avg Price</th>
                    <th className="px-4 py-2 font-medium text-right">LTP</th>
                    <th className="px-4 py-2 font-medium text-right">P&L</th>
                    <th className="px-4 py-2 font-medium text-right">P&L%</th>
                    <th className="px-4 py-2 font-medium text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position) => (
                    <PositionRow
                      key={position.symbol}
                      position={position}
                      onClose={handleClosePosition}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Execution Log (40%) */}
        <div className="flex-[2] min-w-0">
          <TradeExecutionLog />
        </div>
      </div>

      {/* Recent Trades Grid */}
      {closedTradesLast10.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">
            Recent Trades
            <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
              (Last 10 closed)
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {closedTradesLast10.map((trade) => (
              <TradeCard key={trade.id} trade={trade} />
            ))}
          </div>
        </div>
      )}

      {/* Floating Action Button */}
      <button
        onClick={() => setShowTradeModal(true)}
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-[var(--color-accent-blue)] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-500 transition-all hover:scale-105"
      >
        <Plus size={18} />
        Execute Trade
      </button>

      {/* Execute Trade Modal */}
      <ExecuteTradeModal
        isOpen={showTradeModal}
        onClose={() => setShowTradeModal(false)}
      />
    </div>
  );
}
