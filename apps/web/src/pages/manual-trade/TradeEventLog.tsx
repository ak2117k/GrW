import type { TradeEvent, TradeEventType } from '../../types/tradeEvent.types';

interface Props {
  events: TradeEvent[];
}

const EVENT_LABEL: Record<TradeEventType, string> = {
  CREATED: 'CREATED',
  FILLED: 'FILLED',
  SL_SET: 'SL SET',
  TARGET_SET: 'TARGET SET',
  PARTIAL_EXIT: 'PARTIAL EXIT',
  SL_HIT: 'SL HIT',
  TARGET_HIT: 'TARGET HIT',
  MODIFIED: 'MODIFIED',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED',
};

function ts(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return (
    d.toLocaleTimeString('en-IN', { hour12: false }) +
    ' ' +
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  );
}

export function TradeEventLog({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="text-sm text-[var(--color-text-muted)]">No events yet.</div>
    );
  }
  return (
    <div className="text-xs font-mono space-y-1">
      {events.map((e) => (
        <div key={e.id} className="flex gap-3 items-baseline">
          <span className="text-[var(--color-text-muted)] w-32 shrink-0">
            {ts(e.createdAt)}
          </span>
          <span className="w-24 shrink-0 text-blue-400">
            {EVENT_LABEL[e.eventType] ?? e.eventType}
          </span>
          <span className="grow text-[var(--color-text-primary)]">
            {e.price != null && <>₹{e.price.toFixed(2)} </>}
            {e.quantity != null && <>qty={e.quantity} </>}
            {e.pnl != null && (
              <span className={e.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {e.pnl >= 0 ? '+' : ''}₹{e.pnl.toFixed(2)}{' '}
              </span>
            )}
            {e.notes && (
              <span className="text-[var(--color-text-muted)]">— {e.notes}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
