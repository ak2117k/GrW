import { DEFAULT_US_MACRO_QUERIES, ET_COMMODITIES_RSS_URL, googleNewsSearchUrl, REMOVED_SOURCES, rssSources, US_MACRO_RSS_SOURCES } from './news-aggregator.service';

describe('RSS sources — a commodities feed for the MCX underlyings', () => {
  it('includes the Economic Times commodities feed by default', () => {
    const et = rssSources({}).find((s) => s.name === 'ET Commodities');
    expect(et).toEqual({ name: 'ET Commodities', url: ET_COMMODITIES_RSS_URL, category: 'sector' });
    expect(ET_COMMODITIES_RSS_URL).toBe('https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms');
  });

  it('NEWS_COMMODITIES_RSS_URL overrides the URL; "off" removes the source', () => {
    expect(rssSources({ NEWS_COMMODITIES_RSS_URL: 'https://example.test/c.xml' }).find((s) => s.name === 'ET Commodities')?.url).toBe(
      'https://example.test/c.xml',
    );
    expect(rssSources({ NEWS_COMMODITIES_RSS_URL: 'off' }).some((s) => s.name === 'ET Commodities')).toBe(false);
  });

  it('M0: no removed source is fetched, every URL is https and unique, ET Earnings URL is not the malformed one', () => {
    const sources = rssSources({});
    for (const r of REMOVED_SOURCES) expect(sources.map((s) => s.name)).not.toContain(r);
    expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length);
    for (const s of sources) expect(s.url).toMatch(/^https:\/\//);
    expect(sources.map((s) => s.url).join(' ')).not.toMatch(/12aborede/);
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });
});

describe('RSS sources — US macro (US election / Fed / S&P futures / dollar) for the overnight read', () => {
  it('adds the CNBC US feeds and ONE Google News search over the default queries', () => {
    const s = rssSources({});
    for (const n of ['CNBC US Top News', 'CNBC Politics', 'CNBC Economy']) expect(s.find((x) => x.name === n)?.category).toBe('global');
    const g = s.find((x) => x.name === 'Google News US Macro');
    expect(g?.url).toBe(googleNewsSearchUrl(DEFAULT_US_MACRO_QUERIES));
    const q = decodeURIComponent(new URL(g!.url).searchParams.get('q') ?? '');
    expect(q).toContain('(US election results stocks) OR');
    expect(q).toContain('(Federal Reserve)');
    expect(q).toContain('(S&P 500 futures)');
    expect(q).toMatch(/when:1d$/);
    expect(s.filter((x) => x.name.startsWith('Google News')).length).toBe(1);
  });

  it('NEWS_US_MACRO_QUERIES replaces the queries; off removes; NEWS_US_MACRO_FEEDS=off removes the CNBC feeds', () => {
    const g = rssSources({ NEWS_US_MACRO_QUERIES: 'FOMC, nonfarm payrolls ' }).find((x) => x.name === 'Google News US Macro');
    expect(g?.url).toBe(googleNewsSearchUrl(['FOMC', 'nonfarm payrolls']));
    expect(rssSources({ NEWS_US_MACRO_QUERIES: 'off' }).some((x) => x.name === 'Google News US Macro')).toBe(false);
    const noFeeds = rssSources({ NEWS_US_MACRO_FEEDS: 'OFF' });
    expect(noFeeds.some((x) => US_MACRO_RSS_SOURCES.some((u) => u.name === x.name))).toBe(false);
    expect(noFeeds.some((x) => x.name === 'ET Commodities')).toBe(true);
  });
});
