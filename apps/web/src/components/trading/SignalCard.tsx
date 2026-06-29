import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Clock,
  Eye,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/common';
import { formatINR } from '@td/shared';
import type { CombinedTier, TradeSignal } from '@/types';
import { OrderSide } from '@/types';
import StrategyBadge from './StrategyBadge';
import RiskRewardBar from './RiskRewardBar';
import ConfidenceMeter from './ConfidenceMeter';

interface SignalCardProps {
  signal: TradeSignal;
  onViewDetail: (signal: TradeSignal) => void;
  onTakeAction?: (signal: TradeSignal) => void;
  isNew?: boolean;
  className?: string;
}

// Pretty label + Tailwind tone for the Ctx chip. Kept tiny so the dense
// SignalCard top row still breathes — the AnalysisPanel carries the full
// per-factor breakdown for traders who want detail.
function ctxChipTone(tier: CombinedTier | undefined, score: number): string {
  if (tier === 'STRONG_BULL') return 'bg-emerald-500/20 text-emerald-300';
  if (tier === 'BULL') return 'bg-emerald-500/10 text-emerald-300';
  if (tier === 'STRONG_BEAR') return 'bg-red-500/20 text-red-300';
  if (tier === 'BEAR') return 'bg-red-500/10 text-red-300';
  // NEUTRAL or undefined-tier-but-defined-score (defensive): score-based fallback.
  if (score >= 30) return 'bg-emerald-500/15 text-emerald-400';
  if (score <= -30) return 'bg-red-500/15 text-red-400';
  return 'bg-gray-500/20 text-gray-300';
}

function ctxChipLabel(tier: CombinedTier | undefined): string {
  if (!tier) return '';
  return tier.replace('_', ' ');
}

function timeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SignalCard({
  signal,
  onViewDetail,
  onTakeAction,
  isNew = false,
  className,
}: SignalCardProps) {
  const isBuy = signal.side === OrderSide.BUY;
  const cardRef = useRef<HTMLDivElement>(null);

  // Clear new animation after playing
  useEffect(() => {
    if (isNew && cardRef.current) {
      const el = cardRef.current;
      el.classList.add('animate-signal-in');
      const timer = setTimeout(() => el.classList.remove('animate-signal-in'), 600);
      return () => clearTimeout(timer);
    }
  }, [isNew]);

  // Expired signals stay visible (so a trader checking in mid-afternoon
  // can still see the morning's setups) but get a distinct faded look
  // and an EXPIRED badge so they're not confused with currently-actionable
  // signals.
  const isExpired = !signal.isActive;

  return (
    <div
      ref={cardRef}
      className={cn(
        'relative rounded-lg border bg-gray-800/60 transition-all duration-300 hover:bg-gray-800/80',
        isBuy
          ? 'border-l-[3px] border-l-emerald-500 border-t-gray-700/60 border-r-gray-700/60 border-b-gray-700/60'
          : 'border-l-[3px] border-l-red-500 border-t-gray-700/60 border-r-gray-700/60 border-b-gray-700/60',
        // Glow effect for high confidence (active only)
        !isExpired &&
          signal.confidenceScore >= 75 &&
          (isBuy
            ? 'shadow-[0_0_15px_-5px_rgba(16,185,129,0.15)]'
            : 'shadow-[0_0_15px_-5px_rgba(239,68,68,0.15)]'),
        isNew && 'ring-1 ring-amber-400/30',
        isExpired && 'opacity-55 grayscale-[40%]',
        className,
      )}
    >
      <div className="p-4 space-y-3">
        {/* Top row: Symbol + Exchange + Strategy */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-gray-100">
              {signal.symbol}
            </span>
            <Badge label={signal.exchange} variant="info" size="sm" />
            <StrategyBadge strategy={signal.strategy} />
            {signal.chartinkSource && (
              <a
                href={`/chartink?alertId=${signal.chartinkSource.alertId}`}
                title={`Sourced from Chartink scanner: ${signal.chartinkSource.scannerName}`}
                className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-400 hover:bg-blue-500/25"
              >
                <span>📊</span>
                <span>{signal.chartinkSource.scannerName}</span>
              </a>
            )}
            {isExpired && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-700/60 px-1.5 py-0.5 rounded">
                Expired
              </span>
            )}
          </div>
          {/* Side indicator */}
          <div
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold',
              isBuy
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400',
            )}
          >
            {isBuy ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {signal.side}
          </div>
        </div>

        {/* Price section */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-gray-900/50 px-2 py-1.5">
            <div className="text-[10px] text-gray-500 uppercase mb-0.5 flex items-center justify-center gap-1">
              <Target size={10} />
              Entry
            </div>
            <div className="text-sm font-semibold text-gray-200">
              {formatINR(signal.entryPrice)}
            </div>
          </div>
          <div className="rounded-md bg-gray-900/50 px-2 py-1.5">
            <div className="text-[10px] text-emerald-500 uppercase mb-0.5 flex items-center justify-center gap-1">
              <TrendingUp size={10} />
              Target
            </div>
            <div className="text-sm font-semibold text-emerald-400">
              {formatINR(signal.targetPrice)}
            </div>
          </div>
          <div className="rounded-md bg-gray-900/50 px-2 py-1.5">
            <div className="text-[10px] text-red-500 uppercase mb-0.5 flex items-center justify-center gap-1">
              <Shield size={10} />
              SL
            </div>
            <div className="text-sm font-semibold text-red-400">
              {formatINR(signal.stoplossPrice)}
            </div>
          </div>
        </div>

        {/* Risk/Reward */}
        <RiskRewardBar
          riskRewardRatio={signal.riskRewardRatio}
          expectedProfit={signal.expectedProfit}
          expectedLoss={signal.expectedLoss}
        />

        {/* Confidence */}
        <ConfidenceMeter
          score={signal.confidenceScore}
          confidence={signal.confidence}
          size="sm"
        />

        {/* Setup context — rendered only for levels-context signals */}
        {signal.setupContext && (
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3 text-xs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-200">
                  {signal.setupContext.setupType === 'BREAKOUT' ? '↗ Breakout' : '↘ Reversal'}
                </span>
                <span className="rounded bg-gray-700/60 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
                  {signal.setupContext.levelType}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {signal.setupContext.contextScore !== undefined && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                      ctxChipTone(
                        signal.setupContext.contextTier,
                        signal.setupContext.contextScore,
                      ),
                    )}
                    title={`Context score ${signal.setupContext.contextScore > 0 ? '+' : ''}${signal.setupContext.contextScore}${signal.setupContext.contextTier ? ` · ${ctxChipLabel(signal.setupContext.contextTier)}` : ''}`}
                  >
                    {ctxChipLabel(signal.setupContext.contextTier) || 'CTX'}
                    <span className="ml-0.5 tabular-nums">
                      {signal.setupContext.contextScore > 0 ? '+' : ''}
                      {signal.setupContext.contextScore}
                    </span>
                  </span>
                )}
                <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                  signal.setupContext.grade === 'A' ? 'bg-emerald-500/20 text-emerald-300'
                  : signal.setupContext.grade === 'B' ? 'bg-blue-500/20 text-blue-300'
                  : 'bg-gray-500/20 text-gray-300'
                }`}>
                  Grade {signal.setupContext.grade}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px] text-gray-300">
              <div>
                <div className="text-[9px] uppercase text-gray-500">Level</div>
                <div className="font-mono">{signal.setupContext.levelValue.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-gray-500">Vol vs MA</div>
                <div className="font-mono">{signal.setupContext.volumeRatio.toFixed(2)}×</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-gray-500">Window</div>
                <div className="font-mono">{signal.setupContext.timeOfDayWindow.replace('-trend', '')}</div>
              </div>
            </div>
            {signal.setupContext.expiryDayWarning && (
              <div className="mt-2 rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1 text-[10px] text-amber-300">
                ⚠ Expiry day — theta acceleration risk
              </div>
            )}
          </div>
        )}

        {/* Bottom row */}
        <div className="flex items-center justify-between pt-1 border-t border-gray-700/40">
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {timeAgo(signal.createdAt)}
            </span>
            <span>{signal.timeframe}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/charts?symbol=${encodeURIComponent(signal.symbol)}&signal=${signal.id}`}
              className="rounded-md bg-blue-500/15 border border-blue-500/30 px-2.5 py-1 text-[11px] font-medium text-blue-300 hover:bg-blue-500/25 transition-colors"
            >
              📈 View Chart
            </Link>
            {onTakeAction && (
              <button
                onClick={() => onTakeAction(signal)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  isBuy
                    ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                    : 'bg-red-500/20 text-red-400 hover:bg-red-500/30',
                )}
              >
                Take Trade
              </button>
            )}
            <button
              onClick={() => onViewDetail(signal)}
              className="flex items-center gap-1 rounded-md bg-gray-700/50 px-2.5 py-1 text-[11px] font-medium text-gray-300 hover:bg-gray-700/80 transition-colors"
            >
              <Eye size={12} />
              Details
            </button>
          </div>
        </div>
      </div>

      {/* CSS for animation — injected once */}
      <style>{`
        @keyframes signal-in {
          0% { opacity: 0; transform: scale(0.97) translateY(-4px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        .animate-signal-in {
          animation: signal-in 0.4s ease-out;
        }
      `}</style>
    </div>
  );
}
