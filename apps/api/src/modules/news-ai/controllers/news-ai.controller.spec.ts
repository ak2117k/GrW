import { ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../../../common/decorators';
import { NewsController } from '../../news/controllers/news.controller';
import { NewsAiBriefService } from '../services/news-ai-brief.service';
import { cfg, FakeLlm, FakeStore } from '../testing/fakes';
import { briefRefreshAllowed, citedIds, NewsAiController } from './news-ai.controller';

const reflector = new Reflector();
const user = (userId: string, role = 'USER') => ({ userId, role, email: 'x@y.z' });

function setup() {
  const store = new FakeStore();
  const config = cfg({ ownerUserId: 'owner-1' });
  const briefs = new NewsAiBriefService(store, new FakeLlm(), config);
  return { store, briefs, ctl: new NewsAiController(store, briefs, config) };
}

describe('NewsAiController auth', () => {
  const routes = ['brief', 'refresh', 'reads', 'overview'] as const;

  it.each(routes)('%s needs a signed-in user like /api/news (no @Public)', (m) => {
    expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [NewsAiController.prototype[m], NewsAiController])).toBeUndefined();
    // Same posture as the existing news controller.
    expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [NewsController.prototype.getNews, NewsController])).toBeUndefined();
    expect(reflector.getAllAndOverride(ROLES_KEY, [NewsAiController.prototype[m], NewsAiController])).toBeUndefined();
  });

  it('refresh carries a 1-per-minute throttle', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', NewsAiController.prototype.refresh)).toBe(1);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', NewsAiController.prototype.refresh)).toBe(60_000);
  });

  it('only the owner or an ADMIN may refresh', () => {
    expect(briefRefreshAllowed(user('owner-1'), 'owner-1')).toBe(true);
    expect(briefRefreshAllowed(user('someone', 'ADMIN'), 'owner-1')).toBe(true);
    expect(briefRefreshAllowed(user('someone'), 'owner-1')).toBe(false);
    expect(briefRefreshAllowed(user('someone'), null)).toBe(false);
    expect(briefRefreshAllowed(undefined, 'owner-1')).toBe(false);
  });

  it('a plain user gets 403; the owner starts a build; a second start within a minute gets 429', async () => {
    const { ctl, briefs } = setup();
    await expect(ctl.refresh(user('someone'))).rejects.toBeInstanceOf(ForbiddenException);
    jest.spyOn(briefs, 'run').mockResolvedValue({ ran: true });
    await expect(ctl.refresh(user('owner-1'))).resolves.toEqual({ status: 'started' });
    const err = await ctl.refresh(user('owner-1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('refresh says off when NEWS_AI=off and unavailable while the tables are missing (no build starts)', async () => {
    const store = new FakeStore();
    const off = cfg({ ownerUserId: 'owner-1', enabled: false });
    const offBriefs = new NewsAiBriefService(store, new FakeLlm(), off);
    await expect(new NewsAiController(store, offBriefs, off).refresh(user('owner-1'))).resolves.toEqual({ status: 'off' });
    const { ctl, briefs, store: s2 } = setup();
    s2.ready = false;
    const run = jest.spyOn(briefs, 'run');
    await expect(ctl.refresh(user('owner-1'))).resolves.toEqual({ status: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('GET /brief tells the page whether this user may refresh', async () => {
    const { ctl } = setup();
    expect((await ctl.brief(user('owner-1'))).canRefresh).toBe(true);
    expect((await ctl.brief(user('x', 'ADMIN'))).canRefresh).toBe(true);
    expect((await ctl.brief(user('someone'))).canRefresh).toBe(false);
    expect((await ctl.brief(undefined)).canRefresh).toBe(false);
  });
});

describe('NewsAiController reads / overview / brief', () => {
  it('reads: splits, dedupes and keys by article id', async () => {
    const { ctl, store } = setup();
    store.reads.set('a', { articleId: 'a', model: 'm', createdAt: new Date(), direction: 'BULL', strength: 1, importance: 2, takeaway: 't', affected: [] });
    const res = await ctl.reads('a, b,a');
    expect(Object.keys(res.reads)).toEqual(['a']);
  });

  it('overview clamps hours to 1..168', async () => {
    const { ctl } = setup();
    expect((await ctl.overview('9999')).hours).toBe(168);
    expect((await ctl.overview('junk')).hours).toBe(24);
    expect((await ctl.overview('0')).hours).toBe(24);
  });

  it('brief returns the latest brief with its cited articles', async () => {
    const { ctl, store } = setup();
    expect(await ctl.brief(user('someone'))).toMatchObject({ brief: null, articles: [] });
    store.articles = [{ id: 'a1', title: 'T', source: 'ET', url: 'u', publishedAt: new Date(), fetchedAt: new Date(), summary: null, category: 'x', relatedSymbols: [], instruments: [], sectors: [], indices: [], markets: [] }];
    store.briefs = [{ id: 'b', createdAt: new Date(), model: 'm', windowFrom: new Date(), windowTo: new Date(), brief: { topStories: [{ articleId: 'a1' }], indices: [{ articleIds: ['a1', 'gone'] }] } as never }];
    const res = await ctl.brief(user('someone'));
    expect(res.articles.map((a) => a.id)).toEqual(['a1']);
  });

  it("the owner's holdings section is only returned to the owner or an ADMIN", async () => {
    const { ctl, store } = setup();
    const holdings = [{ symbol: 'OFSS', direction: 'BULL', summary: 'owner holding', articleIds: [] }];
    store.briefs = [{ id: 'b', createdAt: new Date(), model: 'm', windowFrom: new Date(), windowTo: new Date(), brief: { holdings, topStories: [] } as never }];
    const held = (r: Awaited<ReturnType<typeof ctl.brief>>) => (r.brief?.brief as unknown as { holdings: unknown[] }).holdings;
    expect(held(await ctl.brief(user('owner-1')))).toEqual(holdings);
    expect(held(await ctl.brief(user('x', 'ADMIN')))).toEqual(holdings);
    expect(held(await ctl.brief(user('someone')))).toEqual([]);
    expect(held(await ctl.brief(undefined))).toEqual([]);
    expect((store.briefs[0].brief as unknown as { holdings: unknown[] }).holdings).toEqual(holdings); // stored copy untouched
  });

  it('tables missing: every read endpoint answers empty with ready=false and never queries the tables', async () => {
    const { ctl, store } = setup();
    store.ready = false;
    const spy = jest.spyOn(store, 'latestBrief');
    const readsSpy = jest.spyOn(store, 'readsFor');
    const sinceSpy = jest.spyOn(store, 'readsSince');
    expect(await ctl.brief(user('owner-1'))).toEqual({ enabled: true, ready: false, building: false, canRefresh: true, brief: null, articles: [] });
    expect(await ctl.reads('a,b')).toEqual({ reads: {} });
    const o = await ctl.overview('24');
    expect(o).toMatchObject({ enabled: true, ready: false, total: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(readsSpy).not.toHaveBeenCalled();
    expect(sinceSpy).not.toHaveBeenCalled();
  });

  it('citedIds walks every articleId / articleIds', () => {
    expect(citedIds({ a: { articleIds: ['x', 'y'] }, b: [{ articleId: 'z' }, { articleIds: ['x'] }] }).sort()).toEqual(['x', 'y', 'z']);
  });
});
