import { useRef, useEffect } from 'react';
import { cn } from '@/utils/cn';
import { useTradeStore } from '@/stores/trade-store';
import type { TradeEvent, TradeEventType } from '@/types';
import { OrderSide } from '@/types';
import { Activity } from 'lucide-react';

const eventConfig: Record<TradeEventType, { color: string; label: string }> = {
  OPENED: { color: 'text-blue-400', label: 'OPENED' },
  CLOSED: { color: 'text-gray-300', label: 'CLOSED' },
  MODIFIED: { color: 'text-blue-400', label: 'MODIFIED' },
  REJECTED: { color: 'text-red-400', label: 'REJECTED' },
  SL_HIT: { color: 'text-red-400', label: 'SL HIT' },
  TARGET_HIT: { color: 'text-emerald-400', label: 'TARGET HIT' },
};

function EventRow({ event }: { event: TradeEvent }) {
  const config = eventConfig[event.eventType] || { color: 'text-gray-400', label: event.eventType };
  const isBuy = event.side === OrderSide.BUY;
  const hasPnl = event.pnl !== undefined && event.pnl !== null;
  const isProfit = hasPnl && event.pnl! >= 0;

  const timestamp = new Date(event.timestamp).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex items-start gap-3 px-3 py-2 border-b border-[var(--color-border-subtle)] last:border-b-0 hover:bg-[var(--color-bg-tertiary)]/50 transition-colors">
      {/* Timestamp */}
      <span className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap mt-0.5 font-mono">
        {timestamp}
      </span>

      {/* Event badge */}
      <span className={cn('text-[10px] font-bold whitespace-nowrap mt-0.5', config.color)}>
        {config.label}
      </span>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
            {event.symbol}
          </span>
          <span
            className={cn(
              'text-[9px] font-bold px-1 rounded',
              isBuy ? 'text-emerald-400' : 'text-red-400',
            )}
          >
            {event.side}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            x{event.quantity}
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)]">
            @{event.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
        </div>
        {hasPnl && (
          <span
            className={cn(
              'text-[10px] font-medium',
              isProfit ? 'text-emerald-400' : 'text-red-400',
            )}
          >
            P&L: {isProfit ? '+' : ''}
            {event.pnl!.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
          </span>
        )}
        {event.message && (
          <p className="text-[10px] text-[var(--color-text-muted)] truncate">{event.message}</p>
        )}
      </div>
    </div>
  );
}

export default function TradeExecutionLog() {
  const executionLog = useTradeStore((s) => s.executionLog);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top on new event
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [executionLog.length]);

  return (
    <div className="flex flex-col h-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <Activity size={14} className="text-[var(--color-accent-blue)]" />
        <span className="text-xs font-semibold text-[var(--color-text-primary)]">
          Execution Log
        </span>
        {executionLog.length > 0 && (
          <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
            {executionLog.length} events
          </span>
        )}
      </div>

      {/* Scrollable list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '500px' }}>
        {executionLog.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-[var(--color-text-muted)]">
            No trade events yet
          </div>
        ) : (
          executionLog.map((event) => (
            <EventRow key={event.id} event={event} />
          ))
        )}
      </div>
    </div>
  );
}
