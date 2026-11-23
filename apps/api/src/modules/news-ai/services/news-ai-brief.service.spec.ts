import type { ReadArticle } from '../domain/news-ai.inputs';
import { cfg, FakeLlm, FakeStore } from '../testing/fakes';
import { BriefRateLimitedError, NewsAiBriefService } from './news-ai-brief.service';

const NOW = new Date('2026-11-23T06:00:00Z'); // Mon 11:30 IST
const H = 3_600_000;

const r = (id: string, hoursAgo: number, importance: number, over: Partial<ReadArticle> = {}): ReadArticle => ({
  id,
  title: `t ${id}`,
  source: 'ET',
  publishedAt: new Date(NOW.getTime() - hoursAgo * H),
  direction: 'BEAR',
  strength: 60,
  importance,
  takeaway: `tk ${id}`,
  affected: [],
  readAt: NOW,
  ...over,
});

const briefFor = (ids: string[]) => ({
  headline: 'h',
  indiaTone: { direction: 'BEAR', summary: 's', articleIds: [ids[0]] },
  globalTone: { direction: 'NEUTRAL', summary: 's', articleIds: [] },
  indices: [{ name: 'NIFTY', direction: 'BEAR', summary: 's', articleIds: [ids[0]] }],
  sectors: [],
  commodities: [],
  holdings: [],
  topStories: [{ articleId: ids[0], headline: 'h', direction: 'BEAR', whyItMatters: 'w' }],
  watchNext: [],
});

function setup(over = {}) {
  const store = new FakeStore();
  const llm = new FakeLlm(undefined, (msg) => briefFor([...msg.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1])));
  const svc = new NewsAiBriefService(store, llm, cfg({ ownerUserId: 'owner-1', ...over }));
  return { store, llm, svc };
}

describe('NewsAiBriefService', () => {
  it('sends the most important AI reads plus holdings and stores the validated brief', async () => {
    const { store, llm, svc } = setup({ briefMaxArticles: 2, briefMinRecent: 1 });
    store.extraReads = [r('low', 1, 10), r('top', 2, 95), r('mid', 3, 50), r('old', 30, 100)];
    store.holdings = [{ symbol: 'SBIN-EQ', exchange: 'NSE', kind: 'HOLDING', qty: 100, pnl: -250 }];

    const res = await svc.run(NOW, 'manual');

    expect(res).toMatchObject({ ran: true, articles: 2, briefId: 'b1' });
    const msg = llm.briefMessages[0];
    expect(msg.indexOf('[top]')).toBeGreaterThan(-1);
    expect(msg.indexOf('[top]')).toBeLessThan(msg.indexOf('[mid]'));
    expect(msg).not.toContain('[low]');
    expect(msg).not.toContain('[old]');
    expect(msg).toContain('SBIN-EQ (NSE, HOLDING, qty 100, P&L -250)');
    expect(store.briefs[0]).toMatchObject({ model: 'claude-opus-5', windowTo: NOW });
    expect(store.briefs[0].brief.topStories[0].articleId).toBe('top');
  });

  it('a reply citing no known article is rejected and nothing is stored', async () => {
    const { store, llm, svc } = setup();
    store.extraReads = [r('a', 1, 50)];
    llm.briefReply = () => briefFor(['invented']);
    const res = await svc.run(NOW, 'manual');
    expect(res.reason).toMatch(/invalid reply/);
    expect(store.briefs).toHaveLength(0);
  });

  it('tables missing (migration not applied) -> no call, nothing stored, building clears', async () => {
    const { store, llm, svc } = setup();
    store.ready = false;
    store.extraReads = [r('a', 1, 50)];
    expect(await svc.run(NOW, 'manual')).toEqual({ ran: false, reason: 'news-ai tables missing' });
    expect(llm.briefMessages).toHaveLength(0);
    expect(store.briefs).toHaveLength(0);
    expect(svc.building).toBe(false);
  });

  it('no AI reads -> no call', async () => {
    const { llm, svc } = setup();
    expect(await svc.run(NOW, 'manual')).toMatchObject({ ran: false });
    expect(llm.briefMessages).toHaveLength(0);
  });

  it('the cron skips when nothing new was read since a fresh brief', async () => {
    const { store, llm, svc } = setup();
    store.extraReads = [r('a', 1, 50)];
    store.briefs = [{ id: 'b0', createdAt: new Date(NOW.getTime() - 10 * 60_000), model: 'm', windowFrom: NOW, windowTo: NOW, brief: briefFor(['a']) as never }];
    expect(await svc.run(NOW, 'cron')).toMatchObject({ ran: false, reason: 'no new AI reads since the last brief' });
    expect(llm.briefMessages).toHaveLength(0);
  });

  it('on-demand refresh is rate-limited to one start per minute', async () => {
    const { store, svc } = setup();
    store.extraReads = [r('a', 1, 50)];
    expect(svc.refresh(NOW)).toEqual({ status: 'started' });
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(() => svc.refresh(new Date(NOW.getTime() + 30_000))).toThrow(BriefRateLimitedError);
    expect(svc.refresh(new Date(NOW.getTime() + 61_000)).status).toMatch(/started|running/);
  });

  it('NEWS_AI=off refuses both triggers', async () => {
    const { svc } = setup({ enabled: false });
    expect(svc.refresh(NOW)).toEqual({ status: 'off' });
    expect(await svc.run(NOW, 'cron')).toMatchObject({ ran: false, reason: 'NEWS_AI off' });
  });
});
