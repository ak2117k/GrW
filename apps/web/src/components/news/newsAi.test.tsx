import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiArticleRead, AiBrief, AiSentimentOverview } from '@/services/newsAi';
import { wireFixture } from '@/services/newsAi.fixture';
import type { NewsItem } from '@/types';
import AiReadBadge from './AiReadBadge';
import { AiSentimentOverviewView, overviewIsEmpty } from './AiSentimentOverview';
import KeywordSentimentOverview from './KeywordSentimentOverview';
import NewsCard from './NewsCard';
import { NewsAiReadsContext } from './NewsAiReadsContext';
import { errorText, mergeLookup, NewsBriefView, refreshText } from './NewsBrief';
import {
  ageLabel,
  chunk,
  dirKey,
  idsToFetch,
  isStale,
  pct100,
  scoreLabel,
  scoreTo100,
  strengthLabel,
} from './newsAiFormat';

const NOW = new Date('2026-11-23T06:00:00.000Z');

const brief: AiBrief = {
  id: 'b1',
  createdAt: '2026-11-23T05:30:00.000Z',
  model: 'claude',
  windowFrom: '2026-11-22T06:00:00.000Z',
  windowTo: '2026-11-23T05:30:00.000Z',
  brief: {
    headline: 'Banks carry NIFTY while IT drags',
    indiaTone: { direction: 'BULL', summary: 'Banks lead on rate-cut hopes.', articleIds: ['a2'] },
    globalTone: { direction: 'BEAR', summary: 'US yields up, Asia weak.', articleIds: [] },
    indices: [{ name: 'NIFTY', direction: 'BULL', summary: 'Breadth positive.', articleIds: ['a1', 'a2'] }],
    sectors: [{ name: 'IT', direction: 'BEAR', summary: 'Weak guidance.', articleIds: ['a3'] }],
    commodities: [{ name: 'CRUDEOIL', direction: 'MIXED', summary: 'OPEC noise.', articleIds: [] }],
    holdings: [{ symbol: 'RELIANCE', direction: 'BULL', summary: 'New order win.', articleIds: ['a1'] }],
    topStories: [{ articleId: 'a1', headline: 'RIL wins big order', whyItMatters: 'Large vs revenue.', direction: 'BULL' }],
    watchNext: [{ item: 'RBI policy Friday', articleIds: ['a3'] }],
  },
};

const read: AiArticleRead = {
  articleId: 'a1',
  model: 'claude-sonnet-5',
  createdAt: '2026-11-23T05:10:00.000Z',
  direction: 'BEAR',
  strength: 70,
  importance: 80,
  takeaway: 'Margin hit for OMCs.',
  affected: [{ kind: 'SECTOR', name: 'OMCS', direction: 'BEAR', why: 'Crude up 3%' }],
};

const article: NewsItem = {
  id: 'a1',
  title: 'Crude jumps',
  summary: 'Brent up',
  source: 'ET',
  url: 'https://example.com/a1',
  category: 'global',
  sentiment: 'neutral',
  relatedSymbols: ['BPCL'],
  publishedAt: new Date('2026-11-23T05:00:00.000Z'),
} as unknown as NewsItem;

describe('newsAiFormat', () => {
  it('maps directions and scores', () => {
    expect(dirKey('BULL')).toBe('bull');
    expect(dirKey('BEAR')).toBe('bear');
    expect(dirKey('MIXED')).toBe('mixed');
    expect(dirKey('NEUTRAL')).toBe('neutral');
    expect(dirKey(undefined)).toBe('neutral');
    expect(scoreTo100(35.4)).toBe(35);
    expect(scoreTo100(1)).toBe(1);
    expect(scoreTo100(-42)).toBe(-42);
    expect(scoreTo100(500)).toBe(100);
    expect(scoreLabel(-20)).toBe('−20');
    expect(scoreLabel(20)).toBe('+20');
  });

  it('labels the server 0..100 strength / importance', () => {
    expect(strengthLabel(70)).toBe('70/100');
    expect(strengthLabel(3)).toBe('3/100');
    expect(strengthLabel(0)).toBe('0/100');
    expect(pct100(140)).toBe(100);
    expect(pct100(-5)).toBe(0);
    expect(pct100(Number.NaN)).toBe(0);
  });

  it('ages and staleness', () => {
    expect(ageLabel('2026-11-23T05:30:00.000Z', NOW)).toBe('30 min ago');
    expect(isStale('2026-11-23T05:30:00.000Z', NOW)).toBe(false);
    expect(isStale('2026-11-22T05:30:00.000Z', NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(true);
  });

  it('fetches only unread ids, retrying old requests', () => {
    const asked = new Map([['b', 1000], ['c', 0]]);
    expect(idsToFetch(['a', 'b', 'c', 'd', 'a'], (id) => id === 'd', asked, 2000, 1500)).toEqual(['a', 'c']);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});

describe('NewsBriefView', () => {
  it('renders all sections with story links', () => {
    const html = renderToStaticMarkup(
      <NewsBriefView
        brief={brief}
        now={NOW}
        canRefresh
        onRefresh={() => {}}
        articleLookup={new Map([['a1', { title: 'RIL order' }], ['a2', { title: 'Banks' }], ['a3', { title: 'RBI' }]])}
      />,
    );
    expect(html).toContain('AI Market Brief');
    expect(html).toContain('Banks lead on rate-cut hopes.');
    expect(html).toContain('US yields up');
    expect(html).toContain('RIL wins big order');
    expect(html).toContain('NIFTY');
    expect(html).toContain('RELIANCE');
    expect(html).toContain('Commodities');
    expect(html).toContain('RBI policy Friday');
    expect(html).toContain('30 min ago');
    expect(html).toContain('title="RIL order"');
    expect(html).toContain('Refresh');
    expect(html).toContain('Banks carry NIFTY while IT drags');
    expect(html).toContain('aria-label="Source 1: RIL order"');
  });

  it('shows a building note and disables refresh while the server builds', () => {
    const html = renderToStaticMarkup(<NewsBriefView brief={brief} building canRefresh onRefresh={() => {}} now={NOW} />);
    expect(html).toContain('Building a new brief');
    expect(html).toContain('disabled');
    expect(renderToStaticMarkup(<NewsBriefView brief={null} building />)).toContain('Claude is reading the latest news');
    expect(renderToStaticMarkup(<NewsBriefView brief={null} enabled={false} />)).toContain('NEWS_AI=off');
    expect(renderToStaticMarkup(<NewsBriefView brief={null} enabled ready={false} />)).toContain('not set up on the server yet');
  });

  it('only the owner/admin sees Refresh and the "press Refresh" hint', () => {
    const other = renderToStaticMarkup(<NewsBriefView brief={null} enabled ready canRefresh={false} onRefresh={() => {}} />);
    expect(other).not.toContain('Refresh');
    expect(other).toContain('No AI brief yet');
    expect(other).toContain('weekdays 08:00');
    const owner = renderToStaticMarkup(<NewsBriefView brief={null} enabled ready canRefresh onRefresh={() => {}} />);
    expect(owner).toContain('press Refresh');
    expect(owner).toContain('>Refresh<');
  });

  it('a cited article that was pruned shows as unavailable, not as a dead link', () => {
    const html = renderToStaticMarkup(<NewsBriefView brief={brief} now={NOW} articleLookup={new Map([['a1', { title: 'RIL order' }]])} />);
    expect(html).toContain('aria-label="Source 1: RIL order"');
    expect(html).toContain('Source article no longer available');
  });

  it('renders the server fixture brief end to end', () => {
    const f = wireFixture();
    const lookup = mergeLookup(undefined, new Map(f.brief.articles.map((a) => [a.id, a])));
    const html = renderToStaticMarkup(
      <NewsBriefView brief={f.brief.brief} enabled={f.brief.enabled} ready={f.brief.ready} canRefresh={f.brief.canRefresh} onRefresh={() => {}} articleLookup={lookup} now={NOW} />,
    );
    expect(html).toContain('Banks lift NIFTY; crude caps oil marketers');
    expect(html).toContain('Bank credit growth hits 16%');
    expect(html).toContain('HDFCBANK');
    expect(html).toContain('RBI policy on Friday');
    expect(html).toContain('Source article no longer available'); // 'gone'
    expect(html).toContain('>Refresh<');
  });

  it('refresh outcomes read as short inline messages', () => {
    expect(refreshText({ status: 'started' })).toBeNull();
    expect(refreshText({ status: 'running' })).toBeNull();
    expect(refreshText({ status: 'off' })).toContain('NEWS_AI=off');
    expect(refreshText({ status: 'unavailable' })).toContain('not set up');
    expect(errorText({ status: 403, message: 'Only the owner or an admin can start a new brief.' })).toContain('owner or an admin');
    expect(errorText({ status: 500, message: 'x' })).toBe('Refresh failed: x');
  });

  it('merges cited refs under the feed (feed wins, cited fills gaps)', () => {
    const m = mergeLookup(
      new Map([['a1', { title: 'Feed title', url: '' }]]),
      new Map([
        ['a1', { id: 'a1', title: 'Cited', source: 'ET', url: 'https://c/a1', publishedAt: '2026-11-23T05:00:00.000Z' }],
        ['a9', { id: 'a9', title: 'Only cited', source: 'ET', url: 'https://c/a9', publishedAt: '2026-11-23T05:00:00.000Z' }],
      ]),
    );
    expect(m.get('a1')).toEqual({ title: 'Feed title', url: 'https://c/a1' });
    expect(m.get('a9')).toEqual({ title: 'Only cited', url: 'https://c/a9' });
  });

  it('shows empty, error and loading states without crashing', () => {
    expect(renderToStaticMarkup(<NewsBriefView brief={null} />)).toContain('No AI brief yet');
    expect(renderToStaticMarkup(<NewsBriefView brief={null} error="boom" />)).toContain('unavailable right now');
    expect(renderToStaticMarkup(<NewsBriefView brief={undefined} isLoading />)).toContain('aria-busy');
    expect(renderToStaticMarkup(<NewsBriefView brief={brief} isRefreshing canRefresh onRefresh={() => {}} />)).toContain('Analysing');
  });

  it('marks a stale brief', () => {
    const html = renderToStaticMarkup(<NewsBriefView brief={{ ...brief, createdAt: '2026-11-22T05:30:00.000Z' }} now={NOW} />);
    expect(html).toContain('text-amber-400');
    expect(html).toContain('1d ago');
  });
});

describe('AI read on the news card', () => {
  it('renders direction, strength, takeaway and affected why on hover', () => {
    const html = renderToStaticMarkup(<AiReadBadge read={read} />);
    expect(html).toContain('Bearish');
    expect(html).toContain('70/100');
    expect(html).toContain('High impact');
    expect(html).toContain('Margin hit for OMCs.');
    expect(html).toContain('OMCS');
    expect(html).toContain('title="sector · bearish · Crude up 3%"');
  });

  it('NewsCard shows the read from context, and nothing without one', () => {
    const withRead = renderToStaticMarkup(
      <NewsAiReadsContext.Provider value={new Map([['a1', read]])}>
        <NewsCard article={article} />
      </NewsAiReadsContext.Provider>,
    );
    expect(withRead).toContain('data-testid="ai-read"');
    expect(withRead).toContain('id="news-card-a1"');
    const without = renderToStaticMarkup(<NewsCard article={article} />);
    expect(without).not.toContain('ai-read');
    expect(without).toContain('Crude jumps');
  });
});

describe('AI sentiment overview', () => {
  const group = (name: string, BULL: number, BEAR: number, score: number) => ({
    name,
    counts: { BULL, BEAR },
    score,
    label: score >= 15 ? ('BULL' as const) : score <= -15 ? ('BEAR' as const) : ('NEUTRAL' as const),
    articleIds: [],
  });
  const ov: AiSentimentOverview = {
    enabled: true,
    ready: true,
    hours: 24,
    from: '2026-11-22T06:00:00.000Z',
    to: '2026-11-23T06:00:00.000Z',
    total: 12,
    overall: { counts: { BULL: 6, BEAR: 2, NEUTRAL: 3, MIXED: 1 }, score: 30, label: 'BULL', avgImportance: 55 },
    indices: [group('NIFTY', 4, 1, 40), group('SENSEX', 0, 0, 0)],
    sectors: [group('BANKS', 1, 2, -25)],
    commodities: [group('CRUDEOIL', 2, 0, 60), group('GOLD', 0, 0, 0)],
  };

  it('renders overall, indices, sectors and commodities; skips zero-count pinned rows', () => {
    const html = renderToStaticMarkup(<AiSentimentOverviewView overview={ov} />);
    expect(html).toContain('AI Sentiment');
    expect(html).toContain('12 articles');
    expect(html).toContain('last 24h');
    expect(html).toContain('+30');
    expect(html).toContain('NIFTY');
    expect(html).toContain('BANKS');
    expect(html).toContain('−25');
    expect(html).toContain('CRUDEOIL');
    expect(html).not.toContain('SENSEX');
    expect(html).not.toContain('GOLD');
  });

  it('renders the server fixture overview', () => {
    const html = renderToStaticMarkup(<AiSentimentOverviewView overview={wireFixture().overview} />);
    expect(html).toContain('2 articles');
    expect(html).toContain('BANKNIFTY');
    expect(html).toContain('CRUDEOIL');
    expect(html).not.toContain('SENSEX');
  });

  it('treats an empty overview as "fall back to keywords"', () => {
    expect(overviewIsEmpty(null)).toBe(true);
    expect(overviewIsEmpty({ ...ov, total: 0, overall: { ...ov.overall, counts: { BULL: 0, BEAR: 0, NEUTRAL: 0, MIXED: 0 } } })).toBe(true);
    expect(overviewIsEmpty({ ...ov, enabled: false })).toBe(true);
    expect(overviewIsEmpty({ ...ov, ready: false })).toBe(true);
    expect(overviewIsEmpty(ov)).toBe(false);
    const html = renderToStaticMarkup(<KeywordSentimentOverview counts={{ bullish: 2, bearish: 1, neutral: 0 }} note="fallback" />);
    expect(html).toContain('Sentiment Overview');
    expect(html).toContain('fallback');
  });
});
