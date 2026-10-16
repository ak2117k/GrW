/** The live packet's read of the events calendar. Type-only port; `peek` is synchronous, no I/O. */
import type { EventsPeek, NewsPosition } from '../../news-events/types';

export interface EventsReader {
  peek(position: NewsPosition, now: Date): EventsPeek;
}

export const MARKET_EVENTS = 'SENTINEL_MARKET_EVENTS';
