import { briefWindowOpen, buildBriefMessage, buildReadMessage, selectBriefArticles, type ReadArticle } from './news-ai.inputs';

const NOW = new Date('2026-11-23T08:00:00Z'); // Mon 13:30 IST
const H = 3_600_000;

function read(id: string, hoursAgo: number, importance: number, extra: Partial<ReadArticle> = {}): ReadArticle {
  return {
    id,
    title: `title ${id}`,
    source: 'ET',
    publishedAt: new Date(NOW.getTime() - hoursAgo * H),
    direction: 'BULL',
    strength: 50,
    importance,
    takeaway: `takeaway ${id}`,
    affected: [],
    readAt: NOW,
    ...extra,
  };
}

describe('selectBriefArticles', () => {
  it('uses the last 6 h when it holds enough reads, most important first, capped', () => {
    const reads = [read('old', 10, 99), ...Array.from({ length: 6 }, (_, i) => read(`r${i}`, 1 + i * 0.5, 10 * i))];
    const sel = selectBriefArticles(reads, [], NOW, { max: 4, minRecent: 3 });
    expect(sel.articles.map((a) => a.id)).toEqual(['r5', 'r4', 'r3', 'r2']);
    expect(sel.windowFrom.getTime()).toBe(NOW.getTime() - 6 * H);
    expect(sel.windowTo).toBe(NOW);
  });

  it('widens to 24 h when the last 6 h is thin, and never takes older than 24 h or future-dated rows', () => {
    const reads = [read('recent', 1, 10), read('h10', 10, 90), read('h30', 30, 100), read('future', -2, 100)];
    const sel = selectBriefArticles(reads, [], NOW, { max: 10, minRecent: 5 });
    expect(sel.articles.map((a) => a.id)).toEqual(['h10', 'recent']);
    expect(sel.windowFrom.getTime()).toBe(NOW.getTime() - 24 * H);
  });

  it('reserves room for a low-importance story on an owner holding', () => {
    const loud = Array.from({ length: 8 }, (_, i) => read(`loud${i}`, 1, 90));
    const held = read('held', 1, 5, { affected: [{ kind: 'STOCK', name: 'RELIANCE', direction: 'BEAR', why: '' }] });
    const sel = selectBriefArticles([...loud, held], [{ symbol: 'RELIANCE-EQ', exchange: 'NSE', kind: 'HOLDING', qty: 10, pnl: null }], NOW, {
      max: 4,
      minRecent: 1,
    });
    expect(sel.articles).toHaveLength(4);
    expect(sel.articles.map((a) => a.id)).toContain('held');
  });

  it('returns nothing when there are no reads', () => {
    expect(selectBriefArticles([], [], NOW, { max: 10, minRecent: 1 }).articles).toEqual([]);
  });
});

describe('message builders', () => {
  it('the read message carries title, summary, source, IST time and existing tags', () => {
    const msg = buildReadMessage({
      id: 'a',
      title: 'RBI holds repo',
      summary: null,
      source: 'Mint',
      category: 'indian',
      publishedAt: NOW,
      relatedSymbols: ['HDFCBANK'],
      instruments: ['HDFCBANK', 'SBIN'],
      sectors: ['BANKS'],
      indices: ['BANKNIFTY'],
      markets: [],
      attempts: 0,
    });
    expect(msg).toContain('Title: RBI holds repo');
    expect(msg).toContain('Summary: (none)');
    expect(msg).toContain('Source: Mint');
    expect(msg).toContain('2026-11-23 13:30 IST');
    expect(msg).toContain('symbols [HDFCBANK, SBIN]');
    expect(msg).toContain('indices [BANKNIFTY]');
  });

  it('the brief message lists holdings and each article with its id to cite', () => {
    const sel = selectBriefArticles([read('a1', 1, 50)], [], NOW, { max: 5, minRecent: 1 });
    const msg = buildBriefMessage(sel, [], NOW);
    expect(msg).toContain('(no open holdings or positions)');
    expect(msg).toContain('[a1]');
    expect(msg).toContain('takeaway: takeaway a1');
  });
});

describe('briefWindowOpen (weekdays 08:00-23:30 IST)', () => {
  it.each([
    ['2026-11-23T02:29:00Z', false], // Mon 07:59 IST
    ['2026-11-23T02:30:00Z', true], // Mon 08:00 IST
    ['2026-11-23T18:00:00Z', true], // Mon 23:30 IST
    ['2026-11-23T18:15:00Z', false], // Mon 23:45 IST
    ['2026-11-21T06:00:00Z', false], // Sat
    ['2026-11-22T06:00:00Z', false], // Sun
  ])('%s -> %s', (iso, open) => {
    expect(briefWindowOpen(new Date(iso))).toBe(open);
  });
});
