import { classifyArticle } from './announcement-classifier';
import { assignClusters, jaccard, titleTokens, type ClusterArticle, type ClusterState } from './clustering';

const T0 = new Date('2026-10-23T05:00:00Z').getTime();
let n = 0;
function art(title: string, source: string, minutes: number, instruments: string[] = []): ClusterArticle {
  return {
    id: `a${++n}`,
    title,
    summary: null,
    source,
    publishedAt: new Date(T0 + minutes * 60_000),
    instruments,
    sectors: [],
    indices: [],
    cls: classifyArticle({ title, source }),
  };
}

describe('story clustering', () => {
  it('normalises titles (stop words, plurals, punctuation)', () => {
    expect(titleTokens("Reliance's shares jump on Q2 profits")).toEqual(['reliance', 'jump', 'q2', 'profit']);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('the same story from three sources with a shared instrument is one cluster with sourceCount 3', () => {
    const open: ClusterState[] = [];
    const a = [
      art('Reliance Q2 profit jumps 12% on retail, Jio', 'Economic Times', 0, ['RELIANCE']),
      art('Reliance Industries Q2 net profit rises 12%', 'LiveMint', 20, ['RELIANCE']),
      art('RELIANCE: Outcome of Board Meeting — approved financial results', 'NSE Announcements', 5, ['RELIANCE']),
    ];
    const m = assignClusters(a, open);
    expect(open).toHaveLength(1);
    expect(new Set(m.values()).size).toBe(1);
    expect(open[0].sources).toHaveLength(3);
    expect(open[0].materialType).toBe('RESULTS');
    // A press headline replaces the NSE filing title.
    expect(open[0].headline).toMatch(/Reliance Q2 profit/);
  });

  it('outside the 6 h window it is a new cluster', () => {
    const open: ClusterState[] = [];
    assignClusters([art('Reliance Q2 profit jumps 12%', 'Economic Times', 0, ['RELIANCE']), art('Reliance Q2 profit jumps 12%', 'LiveMint', 7 * 60, ['RELIANCE'])], open);
    expect(open).toHaveLength(2);
  });

  it('different stories on the same stock stay apart', () => {
    const open: ClusterState[] = [];
    assignClusters([art('Infosys wins large deal from European bank', 'Economic Times', 0, ['INFY']), art('Infosys CFO resigns, shares slip', 'LiveMint', 30, ['INFY'])], open);
    expect(open).toHaveLength(2);
  });

  it('macro headlines without instruments merge only when near-identical', () => {
    const open: ClusterState[] = [];
    assignClusters(
      [
        art('Fed holds rates steady, signals two cuts in 2027', 'CNBC World', 0),
        art('Fed holds rates steady and signals two cuts in 2027', 'MarketWatch', 10),
        art('Crude oil jumps 3% on Middle East supply fears', 'Investing.com Commodities', 15),
      ],
      open,
    );
    expect(open).toHaveLength(2);
    expect(open[0].sources).toEqual(['CNBC World', 'MarketWatch']);
  });

  it('boilerplate never merges', () => {
    const open: ClusterState[] = [];
    assignClusters(
      [
        art('X: Copy of Newspaper Publication — Copy of Newspaper Publication', 'NSE Announcements', 0, ['X']),
        art('X: Copy of Newspaper Publication — Copy of Newspaper Publication', 'NSE Announcements', 1, ['X']),
      ],
      open,
    );
    expect(open).toHaveLength(2);
    expect(open.every((c) => c.boilerplate)).toBe(true);
  });

  it('joins an existing (persisted) cluster', () => {
    const open: ClusterState[] = [];
    assignClusters([art('Tata Motors to acquire Iveco truck business', 'Economic Times', 0, ['TATAMOTORS'])], open);
    open[0].id = 'c1';
    open[0].dirty = false;
    const m = assignClusters([art('Tata Motors acquisition of Iveco approved by board', 'Business Standard Companies', 60, ['TATAMOTORS'])], open);
    expect([...m.values()][0].id).toBe('c1');
    expect(open[0].dirty).toBe(true);
    expect(open[0].sources).toHaveLength(2);
  });
});
