import { createContext, useContext } from 'react';
import type { AiArticleRead } from '@/services/newsAi';

/**
 * Per-article AI reads, provided by NewsPage and consumed by NewsCard, so the
 * feed list in between does not have to thread a prop through.
 */
export const NewsAiReadsContext = createContext<ReadonlyMap<string, AiArticleRead> | null>(null);

export function useNewsAiRead(articleId: string): AiArticleRead | null {
  return useContext(NewsAiReadsContext)?.get(articleId) ?? null;
}
