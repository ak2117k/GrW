/**
 * The live packet's and the wake service's read of the news index (news-events v2).
 * A PORT, type-only, for the reason market-cues.port.ts gives: the cycle's import
 * walk must never reach Prisma, HTTP or the news module. `peek` is synchronous and
 * does no I/O. `onAdded` fires only for article ids the index has never held, and
 * never during its boot rebuild.
 */
import type { IndexedArticle, NewsPeek, NewsPosition } from '../../news-events/types';

export interface NewsIndexReader {
  peek(position: NewsPosition, now: Date): NewsPeek;
  onAdded(listener: (items: readonly IndexedArticle[]) => void): () => void;
}

export const NEWS_INDEX = 'SENTINEL_NEWS_INDEX';
