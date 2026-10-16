import type { EventsPeek, IndexedArticle, NewsPeek, NewsPosition } from './types';

export function article(over: Partial<IndexedArticle> & { id: string }): IndexedArticle {
  return {
    title: `headline ${over.id}`, source: 'ET', sentiment: 'neutral', publishedAt: Date.UTC(2026, 9, 16, 4, 30),
    fetchedAt: Date.UTC(2026, 9, 16, 4, 31), dateInferred: false,
    tags: { instruments: [], sectors: [], indices: [], markets: [] },
    ...over,
  };
}

export function fakeNewsIndex(peek: (p: NewsPosition, now: Date) => NewsPeek) {
  const listeners = new Set<(items: readonly IndexedArticle[]) => void>();
  return {
    peek: jest.fn(peek),
    onAdded: (fn: (items: readonly IndexedArticle[]) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (items: IndexedArticle[]) => listeners.forEach((fn) => fn(items)),
  };
}

export function fakeEvents(peek: (p: NewsPosition, now: Date) => EventsPeek) {
  return { peek: jest.fn(peek) };
}
