import {
  TrendingUp,
  TrendingDown,
  Target,
  Clock,
  Zap,
  Info,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { Modal, Badge } from '@/components/common';
import { formatINR } from '@td/shared';
import type { TradeSignal } from '@/types';
import { OrderSide } from '@/types';
import StrategyBadge from './StrategyBadge';
import RiskRewardBar from './RiskRewardBar';
import ConfidenceMeter from './ConfidenceMeter';

interface SignalDetailModalProps {
  signal: TradeSignal | null;
  isOpen: boolean;
  onClose: () => void;
  onDismiss?: (signal: TradeSignal) => void;
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Mini vertical price ladder */
function PriceLadder({ signal }: { signal: TradeSignal }) {
  const isBuy = signal.side === OrderSide.BUY;
  const prices = [
    { label: 'Target', value: signal.targetPrice, color: 'text-emerald-400', bg: 'bg-emerald-500' },
    { label: 'Entry', value: signal.entryPrice, color: 'text-blue-400', bg: 'bg-blue-500' },
    { label: 'Stoploss', value: signal.stoplossPrice, color: 'text-red-400', bg: 'bg-red-500' },
  ];

  // For SELL, target is below entry
  if (!isBuy) {
    prices.reverse();
  }

  // Sort from high to low
  prices.sort((a, b) => b.value - a.value);

  const max = prices[0].value;
  const min = prices[prices.length - 1].value;
  const range = max - min || 1;

  return (
    <div className="relative flex flex-col gap-0 py-2">
      {/* Vertical line */}
      <div className="absolute left-[6px] top-4 bottom-4 w-px bg-gray-600" />
      {prices.map((p) => {
        const pctFromTop = ((max - p.value) / range) * 100;
        return (
          <div
            key={p.label}
            className="relative flex items-center gap-3 py-2"
            style={{ marginTop: pctFromTop > 50 ? '8px' : '0' }}
          >
            <div className={cn('h-3 w-3 rounded-full border-2 border-gray-800 z-10', p.bg)} />
            <div className="flex items-center gap-2">
              <span className={cn('text-xs font-medium', p.color)}>{p.label}</span>
              <span className="text-sm font-semibold text-gray-200">
                {formatINR(p.value)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SignalDetailModal({
  signal,
  isOpen,
  onClose,
  onDismiss,
}: SignalDetailModalProps) {
  if (!signal) return null;

  const isBuy = signal.side === OrderSide.BUY;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Signal Details" size="lg">
      <div className="space-y-5">
        {/* Header section */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-gray-100">{signal.symbol}</span>
            <Badge label={signal.exchange} variant="info" size="md" />
            <Badge label={signal.segment} variant="neutral" size="md" />
            <StrategyBadge strategy={signal.strategy} />
          </div>
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold',
              isBuy
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400',
            )}
          >
            {isBuy ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
            {signal.side}
          </div>
        </div>

        {/* Price ladder + Details grid */}
        <div className="grid grid-cols-2 gap-5">
          {/* Left: Price ladder */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-900/40 p-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">
              Price Levels
            </h3>
            <PriceLadder signal={signal} />
          </div>

          {/* Right: Metrics */}
          <div className="space-y-4">
            <RiskRewardBar
              riskRewardRatio={signal.riskRewardRatio}
              expectedProfit={signal.expectedProfit}
              expectedLoss={signal.expectedLoss}
            />

            <ConfidenceMeter
              score={signal.confidenceScore}
              confidence={signal.confidence}
              size="lg"
            />

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-gray-900/50 p-2.5">
                <div className="text-[10px] text-gray-500 uppercase mb-0.5">
                  Expected Profit
                </div>
                <div className="text-sm font-semibold text-emerald-400">
                  {formatINR(signal.expectedProfit)}
                </div>
              </div>
              <div className="rounded-md bg-gray-900/50 p-2.5">
                <div className="text-[10px] text-gray-500 uppercase mb-0.5">
                  Expected Loss
                </div>
                <div className="text-sm font-semibold text-red-400">
                  {formatINR(Math.abs(signal.expectedLoss))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Reason */}
        {signal.reason && (
          <div className="rounded-lg border border-gray-700/60 bg-gray-900/40 p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">
              <Info size={12} />
              Signal Reason
            </h3>
            <p className="text-sm text-gray-300 leading-relaxed">{signal.reason}</p>
          </div>
        )}

        {/* Meta info */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {formatTime(signal.createdAt)}
          </span>
          <span className="flex items-center gap-1">
            <Zap size={12} />
            Timeframe: {signal.timeframe}
          </span>
          {signal.optionType && (
            <span>
              Option: {signal.strikePrice} {signal.optionType}
              {signal.expiry ? ` (${signal.expiry})` : ''}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-700/40">
          {onDismiss && (
            <button
              onClick={() => {
                onDismiss(signal);
                onClose();
              }}
              className="rounded-md border border-gray-600 px-4 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-700/50 transition-colors"
            >
              Dismiss Signal
            </button>
          )}
          <div className="relative group">
            <button
              disabled
              className="rounded-md bg-gray-700/50 px-4 py-1.5 text-xs font-medium text-gray-500 cursor-not-allowed"
            >
              <span className="flex items-center gap-1.5">
                <Target size={12} />
                Take Trade
              </span>
            </button>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block">
              <div className="rounded-md bg-gray-900 border border-gray-700 px-3 py-1.5 text-[10px] text-gray-400 whitespace-nowrap shadow-lg">
                Coming in Stage 4
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
