import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewsAiController } from './controllers/news-ai.controller';
import type { NewsBriefBody } from './domain/news-ai.validate';
import { NewsAiBriefService } from './services/news-ai-brief.service';
import { article, cfg, FakeLlm, FakeStore } from './testing/fakes';

/**
 * Wire-contract lock. Builds every /api/news-ai response with the REAL controller (fake store, fixed
 * clock), JSON-round-trips it exactly as Nest sends it, and compares with
 * testing/news-ai.wire-fixture.json. The web client's spec (apps/web/src/services/newsAi.spec.ts)
 * parses that same file, so a server shape change fails one side or the other until both agree.
 * Regenerate deliberately: NEWS_AI_WRITE_FIXTURE=1 npx jest src/modules/news-ai/news-ai.contract
 */
const FIXTURE = join(__dirname, 'testing', 'news-ai.wire-fixture.json');
const NOW = new Date('2026-11-23T05:30:00.000Z');
const user = (userId: string, role = 'USER') => ({ userId, role, email: 'x@y.z' });
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const BODY: NewsBriefBody & { meta: Record<string, unknown> } = {
  headline: 'Banks lift NIFTY; crude caps oil marketers',
  indiaTone: { direction: 'BULL', summary: 'Private banks lead after strong loan growth.', articleIds: ['a1'] },
  globalTone: { direction: 'MIXED', summary: 'US yields up, Asia steady.', articleIds: [] },
  indices: [{ name: 'NIFTY', direction: 'BULL', summary: 'Breadth positive on bank strength.', articleIds: ['a1'] }],
  sectors: [{ name: 'BANKS', direction: 'BULL', summary: 'Loan growth beat.', articleIds: ['a1', 'gone'] }],
  commodities: [{ name: 'CRUDEOIL', direction: 'BEAR', summary: 'OPEC+ supply talk.', articleIds: ['a2'] }],
  holdings: [{ symbol: 'HDFCBANK', direction: 'BULL', summary: 'Direct beneficiary of the loan data.', articleIds: ['a1'] }],
  topStories: [{ articleId: 'a1', headline: 'Bank credit growth hits 16%', direction: 'BULL', whyItMatters: 'Supports BANKNIFTY calls into expiry.' }],
  watchNext: [{ item: 'RBI policy on Friday', articleIds: ['a1'] }],
  meta: { trigger: 'cron', articleCount: 2, holdingCount: 1 },
};

async function build(): Promise<Record<string, unknown>> {
  const store = new FakeStore();
  const config = cfg({ ownerUserId: 'owner-1' });
  const briefs = new NewsAiBriefService(store, new FakeLlm(), config);
  const ctl = new NewsAiController(store, briefs, config);

  store.articles = [
    article('a1', 30, NOW, { title: 'Bank credit growth hits 16%', url: 'https://example.com/a1' }),
    article('a2', 90, NOW, { title: 'OPEC+ weighs output hike', url: 'https://example.com/a2' }),
  ];
  const at = new Date('2026-11-23T05:10:00.000Z');
  store.reads.set('a1', {
    articleId: 'a1', model: 'claude-sonnet-5', createdAt: at, direction: 'BULL', strength: 70, importance: 80,
    takeaway: 'Banks have room to run.', affected: [{ kind: 'INDEX', name: 'BANKNIFTY', direction: 'BULL', why: 'Loan growth.' }, { kind: 'SECTOR', name: 'BANKS', direction: 'BULL', why: 'Credit demand.' }],
  });
  store.reads.set('a2', {
    articleId: 'a2', model: 'claude-sonnet-5', createdAt: at, direction: 'BEAR', strength: 40, importance: 55,
    takeaway: 'Crude soft if supply rises.', affected: [{ kind: 'COMMODITY', name: 'CRUDEOIL', direction: 'BEAR', why: 'More supply.' }],
  });

  const briefEmpty = wire(await ctl.brief(user('someone')));
  store.briefs = [{ id: 'b1', createdAt: new Date('2026-11-23T05:15:00.000Z'), model: 'claude-opus-5', windowFrom: new Date('2026-11-22T23:15:00.000Z'), windowTo: new Date('2026-11-23T05:15:00.000Z'), brief: BODY }];
  jest.spyOn(briefs, 'run').mockResolvedValue({ ran: true });

  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  try {
    return {
      brief: wire(await ctl.brief(user('owner-1'))),
      briefEmpty,
      refresh: wire(await ctl.refresh(user('owner-1'))),
      reads: wire(await ctl.reads('a1,a2,zz')),
      overview: wire(await ctl.overview('24')),
    };
  } finally {
    jest.useRealTimers();
  }
}

describe('news-ai wire contract', () => {
  it('controller output matches testing/news-ai.wire-fixture.json (shared with the web client spec)', async () => {
    const actual = await build();
    if (process.env.NEWS_AI_WRITE_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });

  it('a cited id that no longer exists is left out of articles (the page shows it as unavailable)', async () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { brief: { articles: Array<{ id: string }> } };
    expect(f.brief.articles.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });
});
