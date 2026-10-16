import { keysOfTags } from '../keys';
import type { IndexedArticle } from '../types';

export interface NewsIndexOptions { horizonMs: number; maxItems: number; maxPerKey: number }
export type UpsertResult = 'added' | 'updated' | 'ignored';

/** Newer first; ties broken by id so the order is total and stable. */
const newer = (x: IndexedArticle, y: IndexedArticle) => x.publishedAt > y.publishedAt || (x.publishedAt === y.publishedAt && x.id > y.id);

/** First position in a newest-first list at which `a` belongs (everything before it is strictly newer). */
function slot(list: readonly IndexedArticle[], a: IndexedArticle): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newer(list[mid], a)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Spec §6. Items keyed `I:/S:/X:/M:` → newest-first lists. Bounded by the horizon,
 * ≤ maxPerKey per key and ≤ maxItems total (the oldest article is evicted first).
 * Every list — the per-key ones and the global age order — is kept sorted by binary
 * insertion, so nothing re-sorts on insert and eviction is O(1). No I/O.
 */
export class NewsIndex {
  private readonly items = new Map<string, { a: IndexedArticle; keys: string[] }>();
  private readonly byKey = new Map<string, IndexedArticle[]>();
  /** Every held article, newest first (the oldest is at the end). */
  private readonly order: IndexedArticle[] = [];
  private maxFetched: number | null = null;

  constructor(private readonly o: NewsIndexOptions) {}

  get size(): number {
    return this.items.size;
  }

  get keyCount(): number {
    return this.byKey.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  newestFetchedAt(): number | null {
    return this.maxFetched;
  }

  /** The held article with this id (no copy), or undefined. */
  get(id: string): IndexedArticle | undefined {
    return this.items.get(id)?.a;
  }

  /** Every held article published at or after `sinceMs`, newest first (a fresh array). */
  itemsSince(sinceMs: number): IndexedArticle[] {
    let end = 0;
    while (end < this.order.length && this.order[end].publishedAt >= sinceMs) end++;
    return this.order.slice(0, end);
  }

  upsert(a: IndexedArticle, now: number): UpsertResult {
    if (a.publishedAt < now - this.o.horizonMs) return 'ignored';
    const prev = this.items.get(a.id);
    if (prev) this.remove(prev.a.id);
    const keys = [...new Set(keysOfTags(a.tags))];
    if (keys.length === 0) return prev ? 'updated' : 'ignored';
    this.items.set(a.id, { a, keys: [...keys] });
    this.order.splice(slot(this.order, a), 0, a);
    for (const k of keys) this.insert(k, a);
    while (this.items.size > this.o.maxItems) this.remove(this.order[this.order.length - 1].id);
    if (!this.items.has(a.id)) return prev ? 'updated' : 'ignored';
    this.maxFetched = Math.max(this.maxFetched ?? a.fetchedAt, a.fetchedAt);
    return prev ? 'updated' : 'added';
  }

  prune(now: number): number {
    const cutoff = now - this.o.horizonMs;
    let n = 0;
    while (this.order.length > 0 && this.order[this.order.length - 1].publishedAt < cutoff) {
      this.remove(this.order[this.order.length - 1].id);
      n++;
    }
    return n;
  }

  list(key: string, sinceMs: number): readonly IndexedArticle[] {
    const l = this.byKey.get(key);
    if (!l) return [];
    let end = 0;
    while (end < l.length && l[end].publishedAt >= sinceMs) end++;
    return l.slice(0, end);
  }

  /** Structural estimate (UTF-16 strings + per-object and per-reference overhead) for the spec §6 ceiling. */
  approxBytes(): number {
    let b = 0;
    for (const { a, keys } of this.items.values()) {
      b += 160 + 2 * (a.id.length + a.title.length + a.source.length + (a.sentiment?.length ?? 0));
      for (const t of [...a.tags.instruments, ...a.tags.sectors, ...a.tags.indices, ...a.tags.markets, ...(a.tags.drivers ?? [])]) b += 16 + 2 * t.length;
      b += keys.length * (16 + 8); // the key list on the item + the reference in each per-key array
      b += 8; // the reference in the age order
    }
    for (const k of this.byKey.keys()) b += 64 + 2 * k.length;
    return b;
  }

  private insert(key: string, a: IndexedArticle): void {
    let list = this.byKey.get(key);
    if (!list) {
      list = [];
      this.byKey.set(key, list);
    }
    list.splice(slot(list, a), 0, a);
    while (list.length > this.o.maxPerKey) this.unref(list.pop()!.id, key);
  }

  /** Drop one key's reference; an article left with no key leaves the index. */
  private unref(id: string, key: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.keys = e.keys.filter((k) => k !== key);
    if (e.keys.length === 0) this.remove(id);
  }

  /** Remove an article from every list it is on and from the index. */
  private remove(id: string): void {
    const e = this.items.get(id);
    if (!e) return;
    this.items.delete(id);
    for (const k of e.keys) {
      const list = this.byKey.get(k);
      if (!list) continue;
      const i = slot(list, e.a);
      if (list[i]?.id === id) list.splice(i, 1);
      if (list.length === 0) this.byKey.delete(k);
    }
    const j = slot(this.order, e.a);
    if (this.order[j]?.id === id) this.order.splice(j, 1);
  }
}
