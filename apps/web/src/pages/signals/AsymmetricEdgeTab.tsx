import { Link } from 'react-router-dom';
import {
  Loader2,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Zap,
  ArrowUpRight,
  Clock,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { formatINR } from '@td/shared';
import { EmptyState, LoadingSkeleton, Badge } from '@/components/common';
import {
  useAsymmetricSignals,
  type AsymmetricSignalRow,
  type AsymmetricSortKey,
} from '@/hooks/useAsymmetricSignals';

function formatLastScan(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'B':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'C':
    default:
      return 'bg-gray-500/20 text-gray-300 border-gray-500/40';
  }
}

function AsymmetricCard({ signal }: { signal: AsymmetricSignalRow }) {
  const isBuy = signal.side === 'BUY';
  const symbol = signal.instrument?.symbol ?? signal.setupContext?.symbol ?? '—';
  const exchange = signal.instrument?.exchange ?? 'NSE';
  const token = signal.instrument?.token ?? signal.setupContext?.token ?? '';
  const rr = signal.riskRewardRatio ?? 0;
  const strikeRec = signal.setupContext?.strikeRec ?? null;
  const created = new Date(signal.createdAt);

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/60 p-4 hover:border-amber-500/40 transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-gray-100">{symbol}</span>
            <Badge label={exchange} variant="info" size="sm" />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
            <Clock size={10} />
            <span>
              {created.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
            </span>
            <span>· {signal.timeframe}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold',
              isBuy
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400',
            )}
          >
            {isBuy ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {signal.side}
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold',
              gradeColor(signal.confidence),
            )}
          >
            {signal.confidence}
          </span>
        </div>
      </div>

      {/* R:R hero */}
      <div className="mt-3 rounded-lg bg-gradient-to-br from-amber-500/10 to-amber-600/5 border border-amber-500/30 p-3">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-amber-300/80">
              Risk : Reward
            </div>
            <div className="mt-0.5 text-2xl font-extrabold text-amber-300">
              1 : {rr.toFixed(1)}
            </div>
          </div>
          <Zap size={28} className="text-amber-400/40" />
        </div>
      </div>

      {/* Entry / SL / Target */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-md bg-gray-800/60 p-2">
          <div className="flex items-center gap-1 text-gray-500 uppercase tracking-wide">
            <Target size={10} /> Entry
          </div>
          <div className="mt-0.5 font-semibold text-gray-100">
            {formatINR(signal.entryPrice)}
          </div>
        </div>
        <div className="rounded-md bg-red-500/5 p-2">
          <div className="flex items-center gap-1 text-red-400 uppercase tracking-wide">
            <Shield size={10} /> SL
          </div>
          <div className="mt-0.5 font-semibold text-red-300">
            {formatINR(signal.stoplossPrice)}
          </div>
        </div>
        <div className="rounded-md bg-emerald-500/5 p-2">
          <div className="flex items-center gap-1 text-emerald-400 uppercase tracking-wide">
            <Target size={10} /> Target
          </div>
          <div className="mt-0.5 font-semibold text-emerald-300">
            {formatINR(signal.targetPrice)}
          </div>
        </div>
      </div>

      {/* Option play */}
      {strikeRec ? (
        <div className="mt-3 rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">
              Option play
            </div>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-bold',
                strikeRec.side === 'CE'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-red-500/15 text-red-300',
              )}
            >
              {strikeRec.side}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <div className="text-sm font-semibold text-gray-100">
              {strikeRec.strike} {strikeRec.side}
            </div>
            <div className="text-[11px] text-gray-400">{strikeRec.expiry}</div>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[10px]">
            <div>
              <div className="text-gray-500">Premium</div>
              <div className="text-gray-200 font-medium">
                {formatINR(strikeRec.ltp)}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Δ</div>
              <div className="text-gray-200 font-medium">
                {strikeRec.delta.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-gray-500">IV</div>
              <div className="text-gray-200 font-medium">
                {strikeRec.iv.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-gray-500">Exp ₹/sh</div>
              <div className="text-emerald-300 font-medium">
                {formatINR(strikeRec.expectedProfitPerLot)}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Reason */}
      <p className="mt-3 line-clamp-2 text-[11px] text-gray-400">
        {signal.reason}
      </p>

      {/* Footer actions */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">
          {signal.strategy}
        </span>
        {token ? (
          <Link
            to={`/charts?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}&signal=${signal.id}`}
            className="inline-flex items-center gap-1 rounded-md bg-gray-700/60 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 transition-colors"
          >
            View Chart <ArrowUpRight size={11} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export default function AsymmetricEdgeTab() {
  const {
    signals,
    isLoading,
    isScanRunning,
    lastScanAt,
    sortKey,
    setSortKey,
    triggerScan,
  } = useAsymmetricSignals();

  return (
    <div className="space-y-4">
      {/* Sub-toolbar: sort + manual scan */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-700/60 bg-gray-900/40 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span>Last scan: <span className="text-gray-200">{formatLastScan(lastScanAt)}</span></span>
          <span className="text-gray-600">·</span>
          <span>{signals.length} active</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as AsymmetricSortKey)}
            className="rounded-md border border-gray-700 bg-gray-800/60 px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-amber-500/60"
          >
            <option value="rr">Sort: R:R desc</option>
            <option value="time">Sort: Newest</option>
            <option value="symbol">Sort: Symbol</option>
          </select>
          <button
            onClick={triggerScan}
            disabled={isScanRunning}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-all',
              isScanRunning
                ? 'bg-amber-500/20 text-amber-400 cursor-wait'
                : 'bg-amber-500 text-gray-900 hover:bg-amber-400',
            )}
          >
            {isScanRunning ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Zap size={12} />
            )}
            {isScanRunning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <LoadingSkeleton variant="card" count={3} />
        </div>
      ) : signals.length === 0 ? (
        <EmptyState
          icon={<Zap size={48} />}
          title="No asymmetric setups yet"
          description={`Scanner runs every 15 min during market hours (09:30-14:30 IST). Last scan: ${formatLastScan(lastScanAt)}.`}
          action={{ label: 'Scan Now', onClick: triggerScan }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {signals.map((s) => (
            <AsymmetricCard key={s.id} signal={s} />
          ))}
        </div>
      )}
    </div>
  );
}
