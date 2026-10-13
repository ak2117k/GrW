import { ET_COMMODITIES_RSS_URL, rssSources } from './news-aggregator.service';

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

  it('keeps every existing source', () => {
    const names = rssSources({}).map((s) => s.name);
    for (const n of ['Economic Times', 'MoneyControl', 'LiveMint', 'ET Energy', 'ET Stock News']) expect(names).toContain(n);
  });
});
