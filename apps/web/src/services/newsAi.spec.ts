import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('./api', () => ({ default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));

import { getNewsBrief, getNewsReads, getNewsSentimentOverview, NewsAiError, refreshNewsBrief } from './newsAi';
import { wireFixture } from './newsAi.fixture';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('newsAi client against the server wire fixture', () => {
  it('GET /brief: passes the server response through, cited articles keyed by id', async () => {
    const f = wireFixture();
    get.mockResolvedValueOnce({ status: 200, data: f.brief });
    const s = await getNewsBrief();
    expect(get.mock.calls[0][0]).toBe('/news-ai/brief');
    expect(s.enabled).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.building).toBe(false);
    expect(s.canRefresh).toBe(true);
    expect(s.brief).toEqual(f.brief.brief);
    expect(s.brief?.brief.topStories[0].headline).toBe('Bank credit growth hits 16%');
    expect(s.brief?.brief.watchNext[0]).toEqual({ item: 'RBI policy on Friday', articleIds: ['a1'] });
    expect([...s.articles.keys()].sort()).toEqual(['a1', 'a2']);
    // 'gone' is cited but pruned: absent from articles → the panel shows it as unavailable.
    expect(s.brief?.brief.sectors[0].articleIds).toContain('gone');
    expect(s.articles.has('gone')).toBe(false);

    get.mockResolvedValueOnce({ status: 200, data: f.briefEmpty });
    const empty = await getNewsBrief();
    expect(empty).toMatchObject({ brief: null, canRefresh: false, enabled: true, ready: true });
    expect(empty.articles.size).toBe(0);
  });

  it('GET /brief: 404 = module not deployed, 5xx throws quietly, a non-contract 2xx is an error', async () => {
    get.mockResolvedValueOnce({ status: 404, data: {} });
    await expect(getNewsBrief()).resolves.toMatchObject({ brief: null, enabled: false, ready: false, canRefresh: false });
    const cfg = get.mock.calls[0][1] as { validateStatus: (s: number) => boolean };
    expect(cfg.validateStatus(503)).toBe(true);
    expect(cfg.validateStatus(404)).toBe(true);
    expect(cfg.validateStatus(401)).toBe(false);

    get.mockResolvedValueOnce({ status: 502, data: {} });
    await expect(getNewsBrief()).rejects.toBeInstanceOf(NewsAiError);
    get.mockResolvedValueOnce({ status: 200, data: '<html>' });
    await expect(getNewsBrief()).rejects.toBeInstanceOf(NewsAiError);
  });

  it('GET /reads: joins ids, skips the call for none, returns the keyed reads as a list', async () => {
    await expect(getNewsReads([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
    const f = wireFixture();
    get.mockResolvedValueOnce({ status: 200, data: f.reads });
    const rows = await getNewsReads(['a1', 'a2', 'zz']);
    expect(get.mock.calls[0][1].params).toEqual({ ids: 'a1,a2,zz' });
    expect(rows.map((r) => r.articleId).sort()).toEqual(['a1', 'a2']);
    const a1 = rows.find((r) => r.articleId === 'a1')!;
    expect(a1).toMatchObject({ direction: 'BULL', strength: 70, importance: 80, takeaway: 'Banks have room to run.' });
    expect(a1.affected[0]).toEqual({ kind: 'INDEX', name: 'BANKNIFTY', direction: 'BULL', why: 'Loan growth.' });

    get.mockResolvedValueOnce({ status: 404, data: null });
    await expect(getNewsReads(['a1'])).resolves.toEqual([]);
    get.mockResolvedValueOnce({ status: 500, data: null });
    await expect(getNewsReads(['a1'])).rejects.toBeInstanceOf(NewsAiError);
  });

  it('GET /sentiment-overview: the server shape as-is; null on 404', async () => {
    const f = wireFixture();
    get.mockResolvedValueOnce({ status: 200, data: f.overview });
    const o = await getNewsSentimentOverview(24);
    expect(get.mock.calls[0][1].params).toEqual({ hours: 24 });
    expect(o).toEqual(f.overview);
    expect(o?.overall.counts).toEqual({ BULL: 1, BEAR: 1, NEUTRAL: 0, MIXED: 0 });
    // Pinned rows are listed even at zero.
    expect(o?.indices.map((g) => g.name)).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX']);
    expect(o?.commodities.map((g) => g.name)).toEqual(expect.arrayContaining(['CRUDEOIL', 'GOLD', 'SILVER']));

    get.mockResolvedValueOnce({ status: 404, data: null });
    await expect(getNewsSentimentOverview(24)).resolves.toBeNull();
    get.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(getNewsSentimentOverview(24)).rejects.toBeInstanceOf(NewsAiError);
  });

  it('POST /brief/refresh: 202 {status}; 403 / 429 inline errors; 5xx quiet error', async () => {
    const f = wireFixture();
    post.mockResolvedValueOnce({ status: 202, data: f.refresh });
    await expect(refreshNewsBrief()).resolves.toEqual({ status: 'started' });
    const cfg = post.mock.calls[0][2] as { validateStatus: (s: number) => boolean };
    expect(cfg.validateStatus(403)).toBe(true);
    expect(cfg.validateStatus(429)).toBe(true);
    expect(cfg.validateStatus(401)).toBe(false);

    for (const status of ['running', 'off', 'unavailable'] as const) {
      post.mockResolvedValueOnce({ status: 202, data: { status } });
      await expect(refreshNewsBrief()).resolves.toEqual({ status });
    }
    post.mockResolvedValueOnce({ status: 202, data: { status: 'weird' } });
    await expect(refreshNewsBrief()).rejects.toBeInstanceOf(NewsAiError);
    post.mockResolvedValueOnce({ status: 500, data: {} });
    await expect(refreshNewsBrief()).rejects.toBeInstanceOf(NewsAiError);
    post.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(refreshNewsBrief()).rejects.toMatchObject({ status: 403 });
    post.mockResolvedValueOnce({ status: 429, data: {} });
    await expect(refreshNewsBrief()).rejects.toMatchObject({ status: 429 });
  });
});
