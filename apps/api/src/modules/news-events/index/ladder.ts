import { FRESH_WINDOW_MS, LAYER_CAPS, MAX_HEADLINES, NEWS_WINDOW_MS } from '../config';
import { BANK_SECTORS, INDEX_SECTOR, instrumentKeysOf, MCX_GROUP } from '../keys';
import type { FreshItem, IndexedArticle, LayeredHeadline, NewsLayer, NewsPosition, SectorLookup } from '../types';

export interface Rung { layer: NewsLayer; keys: string[] }
type Lister = { list(key: string, sinceMs: number): readonly IndexedArticle[] };

/** Spec §7 / R2. Keys inside a rung are in PRIORITY order (IN before GLOBAL for NSE, GLOBAL first for MCX). */
export function ladderFor(p: NewsPosition, sectors: SectorLookup): Rung[] {
  const rungs: Rung[] = [{ layer: 'instrument', keys: instrumentKeysOf(p) }];
  if (p.kind === 'STOCK') {
    const s = sectors.sectorOf(p.key);
    if (s) rungs.push({ layer: 'sector', keys: [`S:${s}`] });
    rungs.push({ layer: 'index', keys: s && BANK_SECTORS.has(s) ? ['X:NIFTY', 'X:BANKNIFTY'] : ['X:NIFTY'] });
    rungs.push({ layer: 'market', keys: ['M:IN', 'M:GLOBAL'] });
  } else if (p.kind === 'INDEX') {
    const s = INDEX_SECTOR[p.key];
    if (s) rungs.push({ layer: 'sector', keys: [`S:${s}`] });
    rungs.push({ layer: 'market', keys: ['M:IN', 'M:GLOBAL'] });
  } else {
    const g = MCX_GROUP[p.key];
    if (g) rungs.push({ layer: 'sector', keys: [`S:${g}`] });
    rungs.push({ layer: 'market', keys: ['M:GLOBAL', 'M:IN'] });
  }
  return rungs;
}

/** R3: window first, every article claimed by the highest rung that sees it, ceilings 8/3/2/2, total 8. */
export function layeredHeadlines(ix: Lister, rungs: readonly Rung[], now: number): { headlines: LayeredHeadline[]; newestAt: string | null } {
  const since = now - NEWS_WINDOW_MS;
  const claimed = new Set<string>();
  const headlines: LayeredHeadline[] = [];
  for (const r of rungs) {
    const cands: Array<{ a: IndexedArticle; key: string }> = [];
    for (const k of r.keys) {
      for (const a of ix.list(k, since)) {
        if (claimed.has(a.id)) continue;
        claimed.add(a.id);
        cands.push({ a, key: k.slice(2) });
      }
    }
    const room = Math.max(0, Math.min(LAYER_CAPS[r.layer], MAX_HEADLINES - headlines.length));
    const take = cands.slice(0, room).sort((x, y) => y.a.publishedAt - x.a.publishedAt);
    for (const { a, key } of take) {
      headlines.push({
        title: a.title, source: a.source, sentiment: a.sentiment, publishedAt: new Date(a.publishedAt).toISOString(),
        layer: r.layer, key, ageMin: Math.max(0, Math.floor((now - a.publishedAt) / 60_000)),
      });
    }
  }
  const newest = headlines.reduce<number | null>((m, h) => Math.max(m ?? 0, Date.parse(h.publishedAt)), null);
  return { headlines, newestAt: newest === null ? null : new Date(newest).toISOString() };
}

/** `freshCount` (spec §7): own layer, 30 min, inferred publish times excluded. Ids/titles feed the edge-triggered news-hit. */
export function freshInstrument(ix: Lister, rungs: readonly Rung[], now: number): { count: number; fresh: FreshItem[] } {
  const own = rungs.find((r) => r.layer === 'instrument');
  const seen = new Set<string>();
  const fresh: FreshItem[] = [];
  for (const k of own?.keys ?? []) {
    for (const a of ix.list(k, now - FRESH_WINDOW_MS)) {
      if (a.dateInferred || seen.has(a.id)) continue;
      seen.add(a.id);
      fresh.push({ id: a.id, title: a.title });
    }
  }
  return { count: fresh.length, fresh };
}
