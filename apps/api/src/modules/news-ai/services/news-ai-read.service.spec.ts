import { AssistBusyError } from '../../ai-assist/assist-slot';
import { article, cfg, FakeLlm, FakeStore } from '../testing/fakes';
import { NewsAiReplyError } from './news-ai-llm.service';
import { NewsAiReadService } from './news-ai-read.service';

const NOW = new Date('2026-11-23T06:00:00Z');

function setup(over = {}) {
  const store = new FakeStore();
  const llm = new FakeLlm();
  const svc = new NewsAiReadService(store, llm, cfg(over));
  return { store, llm, svc };
}

describe('NewsAiReadService', () => {
  it('reads new articles and skips filtered, already-read and older-than-lookback ones', async () => {
    const { store, llm, svc } = setup();
    store.articles = [
      article('new', 5, NOW, { title: 'Fresh story' }),
      article('filtered', 5, NOW, { filtered: true }),
      article('done', 5, NOW),
      article('stale', 25 * 60, NOW),
    ];
    store.reads.set('done', { articleId: 'done', model: 'm', createdAt: NOW, direction: 'BULL', strength: 1, importance: 1, takeaway: 't', affected: [] });

    const r = await svc.run(NOW);

    expect(r).toMatchObject({ ran: true, picked: 1, stored: 1, failed: 0 });
    expect(llm.readMessages).toHaveLength(1);
    expect(llm.readMessages[0]).toContain('Fresh story');
    expect(store.reads.get('new')).toMatchObject({ model: 'claude-sonnet-5', direction: 'BULL', importance: 70 });
    expect(store.reads.has('filtered')).toBe(false);
  });

  it('a bad reply is rejected (not stored) and counted; retries stop after 2 (3 attempts in all)', async () => {
    const { store, llm, svc } = setup();
    store.articles = [article('a', 5, NOW)];
    llm.readReply = () => ({ direction: 'UP', strength: 300, importance: 1, takeaway: '', affected: [] });

    for (let i = 0; i < 5; i++) await svc.run(NOW);

    expect(llm.readMessages).toHaveLength(3);
    expect(store.reads.has('a')).toBe(false);
    expect(store.failures.get('a')).toMatchObject({ attempts: 3 });
    expect(store.failures.get('a')?.lastError).toMatch(/invalid reply/);
  });

  it('an unparseable reply (NewsAiReplyError) counts as an attempt and a later success stores the read once', async () => {
    const { store, llm, svc } = setup();
    store.articles = [article('a', 5, NOW)];
    let n = 0;
    const ok = llm.readReply;
    llm.readReply = (m) => {
      if (n++ === 0) throw new NewsAiReplyError('the reply was not JSON');
      return ok(m);
    };
    expect(await svc.run(NOW)).toMatchObject({ failed: 1, stored: 0 });
    expect(await svc.run(NOW)).toMatchObject({ failed: 0, stored: 1 });
    expect(await svc.run(NOW)).toMatchObject({ picked: 0 });
    expect(store.failures.get('a')).toMatchObject({ attempts: 1, lastError: 'the reply was not JSON' });
  });

  it('a provider/transport error (429, 529, timeout, schema 400) is NOT an attempt and stops the tick', async () => {
    const { store, llm, svc } = setup({ concurrency: 1 });
    store.articles = ['a', 'b', 'c', 'd'].map((id, i) => article(id, i + 1, NOW));
    llm.readReply = () => {
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    };
    const r = await svc.run(NOW);
    expect(r).toMatchObject({ ran: true, picked: 4, stored: 0, failed: 0, skipped: 3 });
    expect(r.providerError).toMatch(/429/);
    expect(llm.readMessages).toHaveLength(1);
    expect(store.failures.size).toBe(0);
  });

  it('an outage longer than 3 ticks gives up on nothing: every article is read once the provider recovers', async () => {
    const { store, llm, svc } = setup({ concurrency: 3 });
    store.articles = Array.from({ length: 6 }, (_, i) => article(`a${i}`, i + 1, NOW));
    const ok = llm.readReply;
    llm.readReply = () => {
      throw new Error('vertex 529 overloaded');
    };
    for (let i = 0; i < 6; i++) await svc.run(NOW);
    expect(store.failures.size).toBe(0);
    llm.readReply = ok;
    expect(await svc.run(NOW)).toMatchObject({ picked: 6, stored: 6, failed: 0 });
  });

  it('busy capacity (shared slot or agent) is not counted as an attempt', async () => {
    const { store, llm, svc } = setup();
    store.articles = [article('a', 5, NOW), article('b', 6, NOW)];
    let k = 0;
    llm.readReply = () => {
      const agentBusy = Object.assign(new Error('agent full'), { name: 'AgentBusyError' });
      throw k++ === 0 ? new AssistBusyError(1000) : agentBusy;
    };
    expect(await svc.run(NOW)).toMatchObject({ busy: 2, failed: 0 });
    expect(store.failures.size).toBe(0);
  });

  it('a storage error is not an attempt', async () => {
    const { store, svc } = setup();
    store.articles = [article('a', 5, NOW)];
    store.saveReadError = new Error('db down');
    expect(await svc.run(NOW)).toMatchObject({ failed: 1 });
    expect(store.failures.size).toBe(0);
  });

  it('fresh articles go before retries, newest first, capped at the batch size', async () => {
    const { store, llm, svc } = setup({ batch: 2, concurrency: 1 });
    store.articles = [article('older', 30, NOW, { title: 'older' }), article('newest', 1, NOW, { title: 'newest' }), article('retry', 0, NOW, { title: 'retry' })];
    store.failures.set('retry', { attempts: 1, lastError: 'x' });
    await svc.run(NOW);
    expect(llm.readMessages.map((m) => m.split('\n')[0])).toEqual(['Title: newest', 'Title: older']);
  });

  it('tables missing (migration not applied): idles without calling the AI or recording failures', async () => {
    const { store, llm, svc } = setup();
    store.ready = false;
    store.articles = [article('new', 5, NOW)];
    expect(await svc.run(NOW)).toEqual({ ran: false, reason: 'news-ai tables missing' });
    expect(llm.readMessages).toHaveLength(0);
    expect(store.failures.size).toBe(0);
    store.ready = true;
    expect(await svc.run(NOW)).toMatchObject({ ran: true, stored: 1 });
  });

  it('NEWS_AI=off does nothing', async () => {
    const { store, llm, svc } = setup({ enabled: false });
    store.articles = [article('a', 5, NOW)];
    expect(await svc.run(NOW)).toEqual({ ran: false, reason: 'NEWS_AI off' });
    expect(llm.readMessages).toHaveLength(0);
  });
});
