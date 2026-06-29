import { cn } from '@/utils/cn';
import { Badge, PnLDisplay } from '@/components/common';
import type { Trade } from '@/types';
import { TradeStatus, OrderSide } from '@/types';
import { Clock, X } from 'lucide-react';

interface TradeCardProps {
  trade: Trade;
  onClose?: (id: string) => void;
}

export default function TradeCard({ trade, onClose }: TradeCardProps) {
  const isOpen = trade.status === TradeStatus.OPEN || trade.status === TradeStatus.PARTIALLY_FILLED;
  const isBuy = trade.side === OrderSide.BUY;
  const isProfit = trade.pnl >= 0;

  const statusVariant = (() => {
    switch (trade.status) {
      case TradeStatus.OPEN:
      case TradeStatus.PARTIALLY_FILLED:
        return 'info' as const;
      case TradeStatus.CLOSED:
      case TradeStatus.FILLED:
        return isProfit ? ('success' as const) : ('danger' as const);
      case TradeStatus.CANCELLED:
      case TradeStatus.REJECTED:
        return 'warning' as const;
      default:
        return 'neutral' as const;
    }
  })();

  const createdDate = new Date(trade.createdAt);
  const timeStr = createdDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className={cn(
        'relative rounded-lg border p-4 transition-colors',
        'bg-[var(--color-bg-card)] border-[var(--color-border-subtle)]',
        'hover:border-[var(--color-border-default)]',
      )}
    >
      {/* Paper watermark */}
      {trade.isPaper && (
        <div className="absolute top-2 right-2 rotate-12 opacity-20 text-amber-400 text-[10px] font-bold border border-amber-400/40 rounded px-1.5 py-0.5 pointer-events-none select-none">
          PAPER
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {trade.symbol}
          </span>
          <span
            className={cn(
              'text-[10px] font-bold px-1.5 py-0.5 rounded',
              isBuy
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400',
            )}
          >
            {trade.side}
          </span>
        </div>
        <Badge label={trade.status} variant={statusVariant} size="sm" />
      </div>

      {/* Prices */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
        <div className="text-[var(--color-text-muted)]">Entry</div>
        <div className="text-right text-[var(--color-text-primary)]">
          {trade.entryPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </div>
        {trade.exitPrice !== undefined && (
          <>
            <div className="text-[var(--color-text-muted)]">Exit</div>
            <div className="text-right text-[var(--color-text-primary)]">
              {trade.exitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </>
        )}
      </div>

      {/* P&L */}
      <div className="mb-3">
        <PnLDisplay value={trade.pnl} percent={trade.pnlPercent} size="sm" />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {trade.strategy && (
            <span className="text-[10px] text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] rounded px-1.5 py-0.5">
              {trade.strategy}
            </span>
          )}
          {trade.isPaper && (
            <Badge label="PAPER" variant="warning" size="sm" />
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
          <Clock size={10} />
          {timeStr}
        </div>
      </div>

      {/* Close button for open trades */}
      {isOpen && onClose && (
        <button
          onClick={() => onClose(trade.id)}
          className="mt-3 w-full flex items-center justify-center gap-1 rounded py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
        >
          <X size={12} />
          Close
        </button>
      )}
    </div>
  );
}
