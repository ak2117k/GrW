import { NEWS_RECENCY_WINDOW_MS, SentinelNewsAdapter } from './news.adapter';

const NOW = new Date('2026-08-14T10:00:00Z');

const article = (agoMs: number, over: Record<string, unknown> = {}) => ({
  title: `headline ${agoMs}`,
  source: 'moneycontrol',
  sentiment: 'bearish',
  publishedAt: new Date(NOW.getTime() - agoMs),
  ...over,
});

function make() {
  const getNewsForSymbol = jest.fn().mockResolvedValue([]);
  const svc = new SentinelNewsAdapter({ getNewsForSymbol } as never);
  return { svc, getNewsForSymbol };
}

describe('SentinelNewsAdapter', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it('applies the recency window the aggregator does not have', async () => {
    const t = make();
    // `getNewsForSymbol` is `orderBy publishedAt desc, take 20` with NO date
    // filter — for a quiet symbol it returns last month's headlines, which the
    // packet would then label as recent context.
    t.getNewsForSymbol.mockResolvedValue([
      article(60 * 60 * 1000),
      article(NEWS_RECENCY_WINDOW_MS + 60_000),
    ]);

    const result = await t.svc.recentFor('INFY-EQ');

    expect(result?.value).toHaveLength(1);
    expect((result?.value as Array<{ title: string }>)[0].title).toBe('headline 3600000');
  });

  it('keeps a headline exactly at the boundary rather than dropping it', async () => {
    const t = make();
    t.getNewsForSymbol.mockResolvedValue([article(NEWS_RECENCY_WINDOW_MS)]);
    await expect(t.svc.recentFor('INFY')).resolves.not.toBeNull();
  });

  it('returns null when nothing is recent, so the packet states an absence', async () => {
    const t = make();
    t.getNewsForSymbol.mockResolvedValue([article(NEWS_RECENCY_WINDOW_MS + 1)]);
    // Null rather than an empty array with provenance: the packet turns null
    // into an absent block WITH a reason, which is what the agent must read.
    await expect(t.svc.recentFor('INFY')).resolves.toBeNull();
  });

  it('queries the BASE symbol — relatedSymbols is tagged without the series suffix', async () => {
    const t = make();
    await t.svc.recentFor('SUZLON-EQ');
    expect(t.getNewsForSymbol).toHaveBeenCalledWith('SUZLON');
  });

  it('names the window in the provenance, so two packets are distinguishable', async () => {
    const t = make();
    t.getNewsForSymbol.mockResolvedValue([article(1000)]);
    const result = await t.svc.recentFor('INFY');
    expect(result?.source).toContain('6h');
  });

  it('stamps `at` with the newest headline, not with the build time', async () => {
    const t = make();
    const agoMs = 90 * 60 * 1000;
    t.getNewsForSymbol.mockResolvedValue([article(agoMs), article(agoMs + 60_000)]);

    const result = await t.svc.recentFor('INFY');

    // The block's `at` says when the DATA is from. Stamping it now would make a
    // 90-minute-old headline look like it just landed.
    expect(result?.at).toBe(new Date(NOW.getTime() - agoMs).toISOString());
    expect(result?.at).not.toBe(NOW.toISOString());
  });

  it('caps the headline list so the prompt is evidence, not a feed', async () => {
    const t = make();
    t.getNewsForSymbol.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => article(i * 1000)),
    );
    const result = await t.svc.recentFor('INFY');
    expect(result?.value).toHaveLength(8);
  });
});
