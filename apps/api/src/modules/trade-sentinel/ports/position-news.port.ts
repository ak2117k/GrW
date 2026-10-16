import type { IndexedArticle, NewsPosition } from '../../news-events/types';
import type { PositionMatchesPeek } from '../../news-events/context-types';

/** The cycle's read of the open-position matcher (spec §4.4). All methods synchronous; no I/O. */
export interface PositionNewsReader {
  /** The full set of watched underlyings across users (≤ 5 per user). Cheap; rebuild work is deferred. */
  setWatched(positions: readonly NewsPosition[]): void;
  peek(position: NewsPosition, now: Date): PositionMatchesPeek;
  /** positionKeyOf(...) of every watched position this article wakes (K3). Pure over the compiled profiles. */
  wakeHits(article: IndexedArticle): string[];
}
export const POSITION_NEWS = 'SENTINEL_POSITION_NEWS';
