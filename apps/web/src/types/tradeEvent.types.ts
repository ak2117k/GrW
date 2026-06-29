// Per-trade lifecycle event log (Manual Trade terminal).
//
// Mirrors the backend contract for `GET /api/trades/:id/events`:
//   TradeEvent[]  (newest first)
//
// NOTE: this is intentionally distinct from the older event-feed-style
// `TradeEvent` re-exported from `@td/shared` (which models a live event
// stream — symbol/side/timestamp). That type has a different shape and a
// different set of event kinds; this one is the persisted per-trade audit
// log. Kept in its own frontend file so it can evolve with the backend
// without mutating the shared package's versioned wire type.

export type TradeEventType =
  | 'CREATED'
  | 'FILLED'
  | 'SL_SET'
  | 'TARGET_SET'
  | 'PARTIAL_EXIT'
  | 'SL_HIT'
  | 'TARGET_HIT'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'CLOSED';

export interface TradeEvent {
  id: string;
  tradeId: string;
  eventType: TradeEventType;
  price: number | null;
  quantity: number | null;
  pnl: number | null;
  notes: string | null;
  createdAt: string;
}
