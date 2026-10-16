import type { IndexedArticle } from './types';

export const NEWS_INGEST_BUS = 'NEWS_INGEST_BUS';

/** In-process push from the ingesters to the index (spec §3 (a)). A throwing subscriber never blocks the others. */
export interface NewsIngestBus {
  publish(items: readonly IndexedArticle[]): void;
  subscribe(fn: (items: readonly IndexedArticle[]) => void): () => void;
}

export class InProcessNewsIngestBus implements NewsIngestBus {
  private readonly subs = new Set<(items: readonly IndexedArticle[]) => void>();
  constructor(private readonly onError: (err: unknown) => void = () => undefined) {}

  publish(items: readonly IndexedArticle[]): void {
    if (items.length === 0) return;
    for (const fn of [...this.subs]) {
      try {
        fn(items);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  subscribe(fn: (items: readonly IndexedArticle[]) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
