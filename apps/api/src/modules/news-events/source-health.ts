import type { SourceHealth } from './types';

/** Spec §4.4: ≥ 6 consecutive failures ⇒ "down", named in news.asOf. */
export const SOURCE_DOWN_AFTER = 6;

/** In memory; logs only when a source changes state (first failure, down, recovered). */
export class SourceHealthBook {
  private readonly m = new Map<string, SourceHealth>();
  constructor(private readonly log: (line: string) => void = () => undefined) {}

  ok(source: string, items: number, at: Date): void {
    const prev = this.m.get(source);
    this.m.set(source, { source, lastOkAt: at.toISOString(), lastError: null, consecutiveFailures: 0, itemsLastFetch: items });
    if (!prev || prev.consecutiveFailures > 0) this.log(`[news-source] ${source} OK (${items} items)`);
  }

  fail(source: string, error: string, _at: Date): void {
    const prev = this.m.get(source);
    const n = (prev?.consecutiveFailures ?? 0) + 1;
    this.m.set(source, { source, lastOkAt: prev?.lastOkAt ?? null, lastError: error, consecutiveFailures: n, itemsLastFetch: 0 });
    if (n === 1 || n === SOURCE_DOWN_AFTER) {
      this.log(`[news-source] ${source} ${n >= SOURCE_DOWN_AFTER ? 'DOWN' : 'failing'} (${n} consecutive): ${error}`);
    }
  }

  all(): SourceHealth[] {
    return [...this.m.values()].map((h) => ({ ...h }));
  }

  down(): string[] {
    return [...this.m.values()].filter((h) => h.consecutiveFailures >= SOURCE_DOWN_AFTER).map((h) => h.source).sort();
  }

  lastOkAt(): string | null {
    let best: string | null = null;
    for (const h of this.m.values()) if (h.lastOkAt && (!best || h.lastOkAt > best)) best = h.lastOkAt;
    return best;
  }
}
