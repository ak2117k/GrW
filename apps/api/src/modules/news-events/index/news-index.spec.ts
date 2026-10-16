import { NewsIndex } from './news-index';
import { article } from '../testing';

const NOW = Date.UTC(2026, 9, 16, 6, 0);
const H = 3_600_000;
const mk = (o: { horizonMs?: number; maxItems?: number; maxPerKey?: number } = {}) =>
  new NewsIndex({ horizonMs: o.horizonMs ?? 24 * H, maxItems: o.maxItems ?? 5000, maxPerKey: o.maxPerKey ?? 50 });
const tagged = (id: string, minsAgo: number, instruments: string[], markets: Array<'IN' | 'GLOBAL'> = []) =>
  article({ id, publishedAt: NOW - minsAgo * 60_000, fetchedAt: NOW - minsAgo * 60_000, tags: { instruments, sectors: [], indices: [], markets } });

describe('NewsIndex', () => {
  it('get(id) and itemsSince(ms) read without changing anything', () => {
    const ix = mk();
    ix.upsert(tagged('a', 10, ['SBIN']), NOW);
    ix.upsert(tagged('b', 400, ['TCS']), NOW);
    expect(ix.get('a')?.id).toBe('a');
    expect(ix.get('zz')).toBeUndefined();
    expect(ix.itemsSince(NOW - 6 * H).map((x) => x.id)).toEqual(['a']);
    expect(ix.itemsSince(0).map((x) => x.id)).toEqual(['a', 'b']);
    expect(ix.size).toBe(2);
  });

  it('an article with drivers is keyed D:<KEY>', () => {
    const ix = mk();
    ix.upsert(article({ id: 'd', publishedAt: NOW - 60_000, fetchedAt: NOW, tags: { instruments: [], sectors: [], indices: [], markets: [], drivers: ['CRUDE_SUPPLY'] } }), NOW);
    expect(ix.list('D:CRUDE_SUPPLY', 0).map((x) => x.id)).toEqual(['d']);
  });

  it('lists newest-first per key, within a window', () => {
    const ix = mk();
    ix.upsert(tagged('old', 400, ['SBIN']), NOW);
    ix.upsert(tagged('new', 5, ['SBIN']), NOW);
    ix.upsert(tagged('mid', 60, ['SBIN']), NOW);
    expect(ix.list('I:SBIN', NOW - 6 * H).map((a) => a.id)).toEqual(['new', 'mid']);
    expect(ix.list('I:SBIN', 0).map((a) => a.id)).toEqual(['new', 'mid', 'old']);
    expect(ix.list('I:NOPE', 0)).toEqual([]);
  });

  it('added / updated / ignored: re-publishing an id re-keys it and reports "updated"', () => {
    const ix = mk();
    expect(ix.upsert(tagged('a', 1, ['SBIN']), NOW)).toBe('added');
    expect(ix.upsert(tagged('a', 1, ['TCS']), NOW)).toBe('updated');
    expect(ix.list('I:SBIN', 0)).toEqual([]);
    expect(ix.list('I:TCS', 0).map((a) => a.id)).toEqual(['a']);
    expect(ix.upsert(tagged('untagged', 1, []), NOW)).toBe('ignored');
    expect(ix.upsert(tagged('ancient', 25 * 60, ['SBIN']), NOW)).toBe('ignored');
    expect(ix.has('untagged')).toBe(false);
  });

  it('≤ 50 ids per key; an article dropped from its only key leaves the index, one with another key stays', () => {
    const ix = mk();
    ix.upsert(tagged('shared', 120, ['SBIN'], ['IN']), NOW);
    for (let i = 0; i < 60; i++) ix.upsert(tagged(`s${i}`, i, ['SBIN']), NOW);
    expect(ix.list('I:SBIN', 0)).toHaveLength(50);
    expect(ix.has('s59')).toBe(false);
    expect(ix.has('shared')).toBe(true);
    expect(ix.list('M:IN', 0).map((a) => a.id)).toEqual(['shared']);
  });

  it('≤ maxItems in total, oldest evicted first', () => {
    const ix = mk({ maxItems: 100 });
    for (let i = 0; i < 150; i++) ix.upsert(tagged(`k${i}`, i, [`SYM${i}`]), NOW);
    expect(ix.size).toBeLessThanOrEqual(100);
    expect(ix.has('k0')).toBe(true);
    expect(ix.has('k149')).toBe(false);
  });

  it('prune drops everything older than the horizon', () => {
    const ix = mk({ horizonMs: 2 * H });
    ix.upsert(tagged('a', 30, ['SBIN']), NOW);
    ix.upsert(tagged('b', 90, ['SBIN']), NOW);
    expect(ix.prune(NOW + H)).toBe(1);
    expect(ix.list('I:SBIN', 0).map((a) => a.id)).toEqual(['a']);
    expect(ix.keyCount).toBe(1);
  });

  it('newestFetchedAt tracks the max', () => {
    const ix = mk();
    ix.upsert(tagged('a', 30, ['SBIN']), NOW);
    ix.upsert(tagged('b', 10, ['TCS']), NOW);
    expect(ix.newestFetchedAt()).toBe(NOW - 10 * 60_000);
  });

  it('memory ceiling (spec §6): 5,000 items, 160-char titles, 6 tags each ≤ 5 MB', () => {
    const ix = mk();
    for (let i = 0; i < 5000; i++) {
      ix.upsert(article({
        id: `c${String(i).padStart(24, '0')}`, title: 'x'.repeat(160), source: 'Economic Times Markets',
        publishedAt: NOW - (i % 1400) * 60_000, fetchedAt: NOW,
        tags: { instruments: [`SYM${i % 900}`, 'CRUDEOIL'], sectors: ['NIFTY BANK'], indices: ['NIFTY'], markets: ['IN', 'GLOBAL'] },
      }), NOW);
    }
    expect(ix.size).toBeLessThanOrEqual(5000);
    expect(ix.approxBytes()).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
