import api from './api';
import type { TradeEvent } from '../types/tradeEvent.types';

/**
 * Fetch the lifecycle event log for a single trade (newest first).
 *
 * Backend contract: `GET /api/trades/:id/events -> TradeEvent[]`.
 * The endpoint may 404 until the backend ships — callers should treat a
 * failed/empty fetch as "no events yet" rather than an error.
 */
export async function getTradeEvents(id: string): Promise<TradeEvent[]> {
  const { data } = await api.get<TradeEvent[]>(`/trades/${id}/events`);
  return Array.isArray(data) ? data : [];
}
