import { ET_COMMODITIES_RSS_URL, REMOVED_SOURCES, rssSources } from './news-aggregator.service';

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
