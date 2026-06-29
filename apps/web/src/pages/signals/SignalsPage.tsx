import { useState, useCallback } from 'react';
import {
  Zap,
  LayoutGrid,
  List,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Clock,
  Eye,
  Loader2,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { formatINR } from '@td/shared';
import { OrderSide } from '@/types';
import type { TradeSignal } from '@/types';
import type { Column } from '@/components/common';
import {
  StatCard,
  DataTable,
  EmptyState,
  LoadingSkeleton,
  Badge,
} from '@/components/common';
import {
  SignalCard,
  SignalFilters,
  SignalDetailModal,
  StrategyBadge,
  ConfidenceMeter,
} from '@/components/trading';
import AutoTradeDiagnostic from '@/components/trading/AutoTradeDiagnostic';
import { useSignals } from '@/hooks/useSignals';
import { useSignalStore } from '@/stores/signal-store';
import AsymmetricEdgeTab from './AsymmetricEdgeTab';

type ViewMode = 'grid' | 'table';

type SignalsTab = 'signals' | 'asymmetric';

const SIGNALS_TABS: { key: SignalsTab; label: string }[] = [
  { key: 'signals', label: 'Signals' },
  { key: 'asymmetric', label: 'Asymmetric Edge' },
];

export default function SignalsPage() {
  const { signals, activeCount, avgConfidence, isLoading, isScanRunning, triggerScan } =
    useSignals();
  const filters = useSignalStore((s) => s.filters);
  const updateFilters = useSignalStore((s) => s.updateFilters);
  const removeSignal = useSignalStore((s) => s.removeSignal);
  const newSignalIds = useSignalStore((s) => s.newSignalIds);

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [activeTab, setActiveTab] = useState<SignalsTab>('signals');
  const [detailSignal, setDetailSignal] = useState<TradeSignal | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const openDetail = useCallback((signal: TradeSignal) => {
    setDetailSignal(signal);
    setIsDetailOpen(true);
  }, []);

  const closeDetail = useCallback(() => {
    setIsDetailOpen(false);
    setDetailSignal(null);
  }, []);

  const handleDismiss = useCallback(
    (signal: TradeSignal) => {
      removeSignal(signal.id);
    },
    [removeSignal],
  );

  // Count today's signals
  const todayCount = signals.filter((s) => {
    const created = new Date(s.createdAt);
    const today = new Date();
    return created.toDateString() === today.toDateString();
  }).length;

  // Table columns
  const columns: Column<TradeSignal & Record<string, unknown>>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      sortable: true,
      render: (_val, row) => (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-100">{row.symbol}</span>
          <Badge label={row.exchange as string} variant="info" size="sm" />
        </div>
      ),
    },
    {
      key: 'side',
      header: 'Side',
      sortable: true,
      render: (_val, row) => {
        const isBuy = row.side === OrderSide.BUY;
        return (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-bold',
              isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
            )}
          >
            {isBuy ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {row.side as string}
          </span>
        );
      },
    },
    {
      key: 'entryPrice',
      header: 'Entry',
      sortable: true,
      align: 'right',
      render: (val) => (
        <span className="text-gray-200">{formatINR(val as number)}</span>
      ),
    },
    {
      key: 'targetPrice',
      header: 'Target',
      sortable: true,
      align: 'right',
      render: (val) => (
        <span className="text-emerald-400">{formatINR(val as number)}</span>
      ),
    },
    {
      key: 'stoplossPrice',
      header: 'SL',
      sortable: true,
      align: 'right',
      render: (val) => (
        <span className="text-red-400">{formatINR(val as number)}</span>
      ),
    },
    {
      key: 'riskRewardRatio',
      header: 'R:R',
      sortable: true,
      align: 'center',
      render: (val) => {
        const rr = val as number;
        return (
          <span
            className={cn(
              'font-semibold',
              rr >= 2 ? 'text-emerald-400' : rr >= 1 ? 'text-amber-400' : 'text-red-400',
            )}
          >
            1:{rr.toFixed(1)}
          </span>
        );
      },
    },
    {
      key: 'confidenceScore',
      header: 'Confidence',
      sortable: true,
      align: 'center',
      render: (_val, row) => (
        <ConfidenceMeter
          score={row.confidenceScore as number}
          confidence={row.confidence as TradeSignal['confidence']}
          size="sm"
        />
      ),
      width: '140px',
    },
    {
      key: 'strategy',
      header: 'Strategy',
      sortable: true,
      render: (val) => <StrategyBadge strategy={val as string} />,
    },
    {
      key: 'createdAt',
      header: 'Time',
      sortable: true,
      render: (val) => {
        const d = new Date(val as string | Date);
        return (
          <span className="flex items-center gap-1 text-gray-400 text-xs">
            <Clock size={10} />
            {d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </span>
        );
      },
    },
    {
      key: 'id',
      header: 'Actions',
      render: (_val, row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            openDetail(row as unknown as TradeSignal);
          }}
          className="flex items-center gap-1 rounded-md bg-gray-700/50 px-2 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700/80 transition-colors"
        >
          <Eye size={12} />
          View
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {/* Auto-Trade Diagnostic — top of page so it's the first thing you see */}
      <AutoTradeDiagnostic />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-amber-500/10 p-2">
            <Zap size={22} className="text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-100">Trade Signals</h1>
            <p className="text-xs text-gray-500">
              AI-generated opportunities with entry, target, and stoploss levels
            </p>
          </div>
        </div>

        {activeTab === 'signals' && (
          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            <div className="flex rounded-lg border border-gray-700/60 overflow-hidden">
              <button
                onClick={() => setViewMode('grid')}
                className={cn(
                  'p-1.5 transition-colors',
                  viewMode === 'grid'
                    ? 'bg-gray-700 text-gray-100'
                    : 'text-gray-500 hover:text-gray-300',
                )}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={cn(
                  'p-1.5 transition-colors',
                  viewMode === 'table'
                    ? 'bg-gray-700 text-gray-100'
                    : 'text-gray-500 hover:text-gray-300',
                )}
              >
                <List size={16} />
              </button>
            </div>

            {/* Scan button */}
            <button
              onClick={triggerScan}
              disabled={isScanRunning}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-all',
                isScanRunning
                  ? 'bg-amber-500/20 text-amber-400 cursor-wait'
                  : 'bg-amber-500 text-gray-900 hover:bg-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.25)]',
              )}
            >
              {isScanRunning ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Zap size={14} />
              )}
              {isScanRunning ? 'Scanning...' : 'Scan Now'}
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-gray-700/60">
        {SIGNALS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-4 py-2.5 text-xs font-semibold transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-amber-500 text-amber-400'
                : 'text-gray-500 hover:text-gray-300',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'asymmetric' && <AsymmetricEdgeTab />}

      {activeTab === 'signals' && (
        <>
          {/* Stats bar */}
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              title="Active Signals"
              value={activeCount}
              icon={<Target size={16} />}
            />
            <StatCard
              title="Avg Confidence"
              value={`${avgConfidence}%`}
              icon={<Shield size={16} />}
            />
            <StatCard
              title="Today's Signals"
              value={todayCount}
              icon={<Zap size={16} />}
            />
          </div>

          {/* Filters */}
          <SignalFilters filters={filters} onFilterChange={updateFilters} />

          {/* Content */}
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <LoadingSkeleton variant="card" count={6} />
            </div>
          ) : signals.length === 0 ? (
            <EmptyState
              icon={<Zap size={48} />}
              title="No signals yet"
              description="No trade signals have been generated. Click 'Scan Now' to run strategies against live market data, or check Settings to ensure at least one strategy is active."
              action={{ label: 'Scan Now', onClick: triggerScan }}
            />
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {signals.map((signal) => (
                <SignalCard
                  key={signal.id}
                  signal={signal}
                  onViewDetail={openDetail}
                  isNew={newSignalIds.has(signal.id)}
                />
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={signals as (TradeSignal & Record<string, unknown>)[]}
              sortable
              onRowClick={(row) => openDetail(row as unknown as TradeSignal)}
            />
          )}
        </>
      )}

      {/* Detail modal */}
      <SignalDetailModal
        signal={detailSignal}
        isOpen={isDetailOpen}
        onClose={closeDetail}
        onDismiss={handleDismiss}
      />
    </div>
  );
}
