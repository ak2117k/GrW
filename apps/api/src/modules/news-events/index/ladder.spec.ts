import { freshInstrument, ladderFor, layeredHeadlines } from './ladder';
import { NewsIndex } from './news-index';
import { article } from '../testing';
import type { ArticleTags, NewsPosition } from '../types';

const NOW = Date.UTC(2026, 9, 16, 6, 0);
const sectors = { sectorOf: (s: string) => ({ SBIN: 'NIFTY PSU BANK', TCS: 'NIFTY IT' } as Record<string, string>)[s] ?? null };
const stock = (key: string): NewsPosition => ({ kind: 'STOCK', underlying: key, key, exchange: 'NSE', expiry: null });
const ix = () => new NewsIndex({ horizonMs: 24 * 3_600_000, maxItems: 5000, maxPerKey: 50 });
const T = (t: Partial<ArticleTags>): ArticleTags => ({ instruments: [], sectors: [], indices: [], markets: [], ...t });
const put = (i: NewsIndex, id: string, minsAgo: number, tags: Partial<ArticleTags>, over: Record<string, unknown> = {}) =>
  i.upsert(article({ id, publishedAt: NOW - minsAgo * 60_000, fetchedAt: NOW, tags: T(tags), ...over }), NOW);

describe('ladderFor (R2)', () => {
  it('stock in a bank sector: own → sector → NIFTY + BANKNIFTY → IN, GLOBAL', () => {
    expect(ladderFor(stock('SBIN'), sectors)).toEqual([
      { layer: 'instrument', keys: ['I:SBIN'] },
      { layer: 'sector', keys: ['S:NIFTY PSU BANK'] },
      { layer: 'index', keys: ['X:NIFTY', 'X:BANKNIFTY'] },
      { layer: 'market', keys: ['M:IN', 'M:GLOBAL'] },
    ]);
  });
  it('stock with no known sector skips the sector rung', () => {
    expect(ladderFor(stock('ZZZ'), sectors).map((r) => r.layer)).toEqual(['instrument', 'index', 'market']);
  });
  it('index option: the index itself, its sector, no index rung', () => {
    expect(ladderFor({ kind: 'INDEX', underlying: 'BANKNIFTY', key: 'BANKNIFTY', exchange: 'NFO', expiry: null }, sectors)).toEqual([
      { layer: 'instrument', keys: ['X:BANKNIFTY'] },
      { layer: 'sector', keys: ['S:NIFTY BANK'] },
      { layer: 'market', keys: ['M:IN', 'M:GLOBAL'] },
    ]);
    expect(ladderFor({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null }, sectors).map((r) => r.layer)).toEqual(['instrument', 'market']);
  });
  it('MCX future: benchmark → commodity group → GLOBAL then IN', () => {
    expect(ladderFor({ kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null }, sectors)).toEqual([
      { layer: 'instrument', keys: ['I:CRUDEOIL'] },
      { layer: 'sector', keys: ['S:MCX ENERGY'] },
      { layer: 'market', keys: ['M:GLOBAL', 'M:IN'] },
    ]);
  });
});

describe('layeredHeadlines (R3)', () => {
  it('ceilings 8/3/2/2 under a total of 8', () => {
    const i = ix();
    for (let k = 0; k < 2; k++) put(i, `own${k}`, k, { instruments: ['SBIN'] });
    for (let k = 0; k < 5; k++) put(i, `sec${k}`, 10 + k, { sectors: ['NIFTY PSU BANK'] });
    for (let k = 0; k < 3; k++) put(i, `idx${k}`, 20 + k, { indices: ['NIFTY'] });
    for (let k = 0; k < 4; k++) put(i, `mkt${k}`, 30 + k, { markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h.map((x) => `${x.layer}:${x.key}`)).toEqual([
      'instrument:SBIN', 'instrument:SBIN', 'sector:NIFTY PSU BANK', 'sector:NIFTY PSU BANK', 'sector:NIFTY PSU BANK',
      'index:NIFTY', 'index:NIFTY', 'market:IN',
    ]);
  });
  it('a busy own key takes all 8 and nothing else is shown', () => {
    const i = ix();
    for (let k = 0; k < 12; k++) put(i, `own${k}`, k, { instruments: ['SBIN'] });
    put(i, 'mkt', 1, { markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h).toHaveLength(8);
    expect(h.every((x) => x.layer === 'instrument')).toBe(true);
  });
  it('the 6 h window is applied BEFORE the cap: old own headlines never starve fresh lower layers', () => {
    const i = ix();
    for (let k = 0; k < 20; k++) put(i, `old${k}`, 7 * 60 + k, { instruments: ['SBIN'] });
    put(i, 'fresh', 5, { instruments: ['SBIN'] });
    put(i, 'sec', 6, { sectors: ['NIFTY PSU BANK'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h.map((x) => x.layer)).toEqual(['instrument', 'sector']);
  });
  it('an article keeps its highest layer only (dedupe)', () => {
    const i = ix();
    put(i, 'both', 3, { instruments: ['SBIN'], markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ layer: 'instrument', key: 'SBIN', ageMin: 3 });
  });
  it('MCX: GLOBAL fills before IN in the market rung', () => {
    const i = ix();
    put(i, 'in1', 1, { markets: ['IN'] });
    put(i, 'in2', 2, { markets: ['IN'] });
    put(i, 'gl', 30, { markets: ['GLOBAL'] });
    const h = layeredHeadlines(i, ladderFor({ kind: 'COMMODITY', underlying: 'GOLD', key: 'GOLD', exchange: 'MCX', expiry: null }, sectors), NOW).headlines;
    // GLOBAL is taken first although two newer IN headlines exist; the cap of 2 leaves room for the newest IN.
    // Display order within a layer is newest-first.
    expect(h.map((x) => `${x.key}:${x.ageMin}`)).toEqual(['IN:1', 'GLOBAL:30']);
  });
  it('newestAt is the newest shown headline; empty index → no headlines', () => {
    const i = ix();
    expect(layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW)).toEqual({ headlines: [], newestAt: null });
    put(i, 'a', 12, { instruments: ['SBIN'] });
    expect(layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).newestAt).toBe(new Date(NOW - 12 * 60_000).toISOString());
  });
});

describe('freshInstrument', () => {
  it('own layer only, last 30 min, inferred dates excluded, never saturates at 20', () => {
    const i = ix();
    for (let k = 0; k < 25; k++) put(i, `f${k}`, k, { instruments: ['SBIN'] });
    put(i, 'inferred', 1, { instruments: ['SBIN'] }, { dateInferred: true });
    put(i, 'late', 31, { instruments: ['SBIN'] });
    put(i, 'mkt', 1, { markets: ['IN'] });
    const f = freshInstrument(i, ladderFor(stock('SBIN'), sectors), NOW);
    expect(f.count).toBe(25);
    expect(f.fresh.map((x) => x.id)).not.toContain('inferred');
    expect(f.fresh[0]).toEqual({ id: 'f0', title: 'headline f0' });
  });
});
