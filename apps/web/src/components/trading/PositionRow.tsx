import { useEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import type { Position } from '@/types';
import { OrderSide } from '@/types';
import { X } from 'lucide-react';

interface PositionRowProps {
  position: Position;
  onClose: (symbol: string) => void;
}

export default function PositionRow({ position, onClose }: PositionRowProps) {
  const isBuy = position.side === OrderSide.BUY;
  const isProfit = position.pnl >= 0;

  // Flash on P&L update
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevPnlRef = useRef(position.pnl);

  useEffect(() => {
    if (position.pnl > prevPnlRef.current) {
      setFlash('up');
    } else if (position.pnl < prevPnlRef.current) {
      setFlash('down');
    }
    prevPnlRef.current = position.pnl;

    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [position.pnl]);

  const pnlFormatted = `${isProfit ? '+' : ''}${position.pnl.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  })}`;

  const pnlPercentFormatted = `${isProfit ? '+' : ''}${position.pnlPercent.toFixed(2)}%`;

  return (
    <tr
      className={cn(
        'border-b border-[var(--color-border-subtle)] transition-colors',
        isProfit
          ? 'bg-emerald-500/[0.03] hover:bg-emerald-500/[0.06]'
          : 'bg-red-500/[0.03] hover:bg-red-500/[0.06]',
      )}
    >
      {/* Symbol */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            {position.symbol}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {position.exchange}
          </span>
        </div>
      </td>

      {/* Side */}
      <td className="px-4 py-3">
        <span
          className={cn(
            'text-xs font-bold px-1.5 py-0.5 rounded',
            isBuy
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-red-500/15 text-red-400',
          )}
        >
          {position.side}
        </span>
      </td>

      {/* Qty */}
      <td className="px-4 py-3 text-sm text-[var(--color-text-primary)] text-right">
        {position.quantity}
      </td>

      {/* Avg Price */}
      <td className="px-4 py-3 text-sm text-[var(--color-text-secondary)] text-right">
        {position.averagePrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
      </td>

      {/* LTP */}
      <td className="px-4 py-3 text-right">
        <span
          className={cn(
            'inline-block text-sm rounded px-1 transition-colors duration-500',
            flash === 'up'
              ? 'bg-emerald-500/20 text-emerald-400'
              : flash === 'down'
                ? 'bg-red-500/20 text-red-400'
                : 'text-[var(--color-text-primary)]',
          )}
        >
          {position.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </span>
      </td>

      {/* P&L */}
      <td className="px-4 py-3 text-right">
        <span
          className={cn(
            'inline-block text-sm font-medium rounded px-1 transition-colors duration-500',
            flash === 'up'
              ? 'bg-emerald-500/20'
              : flash === 'down'
                ? 'bg-red-500/20'
                : '',
            isProfit ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {pnlFormatted}
        </span>
      </td>

      {/* P&L % */}
      <td className="px-4 py-3 text-right">
        <span
          className={cn(
            'text-xs',
            isProfit ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {pnlPercentFormatted}
        </span>
      </td>

      {/* Close */}
      <td className="px-4 py-3 text-right">
        <button
          onClick={() => onClose(position.symbol)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
        >
          <X size={12} />
          Close
        </button>
      </td>
    </tr>
  );
}
