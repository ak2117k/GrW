import type { ReadArticle } from './news-ai.inputs';
import { sentimentOverview } from './sentiment-overview';

const NOW = new Date('2026-11-23T06:00:00Z');
const r = (id: string, direction: ReadArticle['direction'], importance: number, strength: number, affected: ReadArticle['affected'] = []): ReadArticle => ({
  id,
  title: id,
  source: 'ET',
  publishedAt: NOW,
  direction,
  strength,
  importance,
  takeaway: '',
  affected,
  readAt: NOW,
});

describe('sentimentOverview', () => {
  it('counts by direction and weights the score by importance x strength', () => {
    const o = sentimentOverview(
      [r('a', 'BULL', 100, 100), r('b', 'BEAR', 20, 50), r('c', 'BEAR', 20, 50), r('d', 'NEUTRAL', 50, 0), r('e', 'MIXED', 10, 10)],
      24,
      NOW,
    );
    expect(o.total).toBe(5);
    expect(o.overall.counts).toEqual({ BULL: 1, BEAR: 2, NEUTRAL: 1, MIXED: 1 });
    // one heavy bull outweighs two light bears
    expect(o.overall.score).toBeGreaterThan(50);
    expect(o.overall.label).toBe('BULL');
    expect(o.overall.avgImportance).toBe(40);
  });

  it('groups per index (aliases merged, pinned order), per sector and per commodity', () => {
    const o = sentimentOverview(
      [
        r('a', 'BEAR', 80, 80, [
          { kind: 'INDEX', name: 'NIFTY 50', direction: 'BEAR', why: '' },
          { kind: 'INDEX', name: 'NIFTY', direction: 'BEAR', why: 'dup in one article' },
          { kind: 'SECTOR', name: 'OIL GAS', direction: 'BEAR', why: '' },
          { kind: 'COMMODITY', name: 'BRENT', direction: 'BULL', why: '' },
        ]),
        r('b', 'BULL', 30, 30, [{ kind: 'INDEX', name: 'BANK NIFTY', direction: 'BULL', why: '' }]),
      ],
      6,
      NOW,
    );
    expect(o.indices.map((g) => g.name)).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX']);
    expect(o.indices[0]).toMatchObject({ counts: { BULL: 0, BEAR: 1 }, score: -100, label: 'BEAR', articleIds: ['a'] });
    expect(o.indices[1]).toMatchObject({ score: 100, label: 'BULL' });
    expect(o.indices[2]).toMatchObject({ counts: { BULL: 0, BEAR: 0 }, score: 0, label: 'NEUTRAL' });
    expect(o.sectors).toEqual([expect.objectContaining({ name: 'OIL_GAS', label: 'BEAR' })]);
    expect(o.commodities[0]).toMatchObject({ name: 'CRUDEOIL', label: 'BULL' });
    expect(o.hours).toBe(6);
  });

  it('empty input is neutral', () => {
    const o = sentimentOverview([], 24, NOW);
    expect(o.overall).toMatchObject({ score: 0, label: 'NEUTRAL', avgImportance: 0 });
  });
});
