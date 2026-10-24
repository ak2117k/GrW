import type { FreshItem } from '../../news-events/types';
import type { NewsImpactHighEvent } from '../../news-impact/news-impact.ports';

/** How long a HIGH impact stays a "fresh headline" for its targets — the news sensor's own window. */
export const HIGH_IMPACT_FRESH_MS = 30 * 60_000;

/**
 * News impact → sentinel (2026-10-24). A HIGH impact the news-impact module analysed for a held
 * symbol / NIFTY / BANKNIFTY becomes ONE extra fresh own-instrument headline (id `impact:<clusterId>`)
 * on that underlying for {@link HIGH_IMPACT_FRESH_MS}. It travels the ordinary news-hit path, so the
 * existing gating applies unchanged: the cycle's seen-set edge-triggers it once per tracker, and the
 * material-change rule (rejudge-suppression `newsUnjudged`) counts it as new exactly once — the same
 * cluster can never wake the judge twice. Memory only; a restart forgets it (at most one missed wake).
 */
export class HighImpactNewsBook {
  private readonly bySymbol = new Map<string, Array<FreshItem & { at: number }>>();

  add(evt: NewsImpactHighEvent, now: number): void {
    const id = `impact:${evt.clusterId}`;
    const title = `[news impact ${evt.magnitude} ${evt.direction}, ${evt.horizon.toLowerCase()}] ${evt.oneLine} — ${evt.headline}`.slice(0, 300);
    for (const raw of evt.targets) {
      const sym = raw.trim().toUpperCase();
      const list = (this.bySymbol.get(sym) ?? []).filter((x) => now - x.at < HIGH_IMPACT_FRESH_MS && x.id !== id);
      list.unshift({ id, title, at: now });
      this.bySymbol.set(sym, list);
    }
  }

  /** The live impact items for an underlying name (newest first). */
  freshFor(symbol: string | null | undefined, now: number): FreshItem[] {
    if (!symbol) return [];
    const list = this.bySymbol.get(symbol.trim().toUpperCase());
    if (!list) return [];
    return list.filter((x) => now - x.at < HIGH_IMPACT_FRESH_MS).map(({ id, title }) => ({ id, title }));
  }
}

/**
 * Merge impact items into a tick's news inputs. v2 (`fresh` given): prepended to the fresh list.
 * Legacy: prepended to the id list when ids are known, and the 30-minute count grows by the same.
 */
export function mergeImpactNews(
  impact: readonly FreshItem[],
  v2Fresh: FreshItem[] | null | undefined,
  legacy: { count: number | null; items: FreshItem[] | null },
): { freshNews: FreshItem[] | null; count: number | null; items: FreshItem[] | null } {
  if (impact.length === 0) return { freshNews: v2Fresh ?? null, count: legacy.count, items: legacy.items };
  const count = (legacy.count ?? 0) + impact.length;
  if (v2Fresh) return { freshNews: [...impact, ...v2Fresh], count, items: legacy.items };
  return { freshNews: null, count, items: legacy.items ? [...impact, ...legacy.items] : legacy.count === null ? [...impact] : null };
}
