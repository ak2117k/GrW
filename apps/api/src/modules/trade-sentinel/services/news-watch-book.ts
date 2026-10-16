/**
 * News & events v2: which open, watched trackers each instrument key belongs to —
 * fed by the cycle's sensor pass, read by {@link NewsWakeService}. Memory only.
 */
export interface NewsWatch {
  trackerId: string;
  userId: string;
  symbol: string;
  exchange: string;
  /** `I:<symbol|benchmark>` or `X:<index>` — the keys an instrument-layer headline can carry. */
  instrumentKeys: string[];
}

export class NewsWatchBook {
  private readonly byTracker = new Map<string, NewsWatch>();

  upsert(w: NewsWatch): void {
    this.byTracker.set(w.trackerId, { ...w, instrumentKeys: [...w.instrumentKeys] });
  }

  /** Drop every tracker of `userId` that is not in `live` (closed, or no longer watched). */
  prune(userId: string, live: Set<string>): void {
    for (const [id, w] of [...this.byTracker]) if (w.userId === userId && !live.has(id)) this.byTracker.delete(id);
  }

  matching(keys: Iterable<string>): NewsWatch[] {
    const k = new Set(keys);
    return [...this.byTracker.values()].filter((w) => w.instrumentKeys.some((x) => k.has(x)));
  }

  has(trackerId: string): boolean {
    return this.byTracker.has(trackerId);
  }

  size(): number {
    return this.byTracker.size;
  }
}
