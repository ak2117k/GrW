import { AssistBusyError } from '../../ai-assist/assist-slot';
import { closedPos, holdingRow, ist } from '../domain/review.fixtures';
import { PortfolioReviewService } from './portfolio-review.service';

const NOW = ist('2026-11-02 13:00');

function setup(opts: { llm?: 'ok' | 'busy' | 'none' | 'denied'; candles?: 'ok' | 'throw' | 'none' } = {}) {
  const trackers = [
    holdingRow('IVALUE-EQ', 302.87, 50, '2026-07-11 18:41', null, 199.67, { token: '1' }),
    closedPos('KEI29SEP265800CE', 271.85, 0.05, 175, '2026-08-17 14:10', '2026-09-30 15:50'),
  ];
  const repo = {
    listTrackers: jest.fn().mockResolvedValue(trackers),
    save: jest.fn().mockResolvedValue('rev1'),
    updateSummary: jest.fn().mockResolvedValue(undefined),
    latestSince: jest.fn().mockResolvedValue(null),
    history: jest.fn().mockResolvedValue([]),
  };
  const live = { listLiveExits: jest.fn().mockResolvedValue([]), listLiveOrders: jest.fn().mockResolvedValue([]) };
  const closes = Array.from({ length: 250 }, (_, i) => ({ timestamp: new Date(), open: 300 - i * 0.4, high: 301 - i * 0.4, low: 299 - i * 0.4, close: 300 - i * 0.4, volume: 1 }));
  const feeds =
    opts.candles === 'none'
      ? undefined
      : { fetchCandles: opts.candles === 'throw' ? jest.fn().mockRejectedValue(new Error('NO_FEED_SESSION')) : jest.fn().mockResolvedValue(closes) };
  const llm =
    opts.llm === 'none'
      ? undefined
      : {
          allowed: jest.fn().mockReturnValue(opts.llm !== 'denied'),
          complete: opts.llm === 'busy' ? jest.fn().mockRejectedValue(new AssistBusyError(20_000)) : jest.fn().mockResolvedValue({ answer: 'You are down mostly on options.', confidence: 80, offTopic: false }),
        };
  const svc = new PortfolioReviewService(repo as never, live as never, feeds as never, llm as never);
  return { svc, repo, feeds, llm };
}

const owner = { userId: 'owner', role: 'ADMIN' };

describe('PortfolioReviewService', () => {
  it('computes, stores and caches for 15 minutes; refresh recomputes', async () => {
    const { svc, repo } = setup({ llm: 'ok' });
    const r1 = await svc.get(owner, {}, NOW);
    expect(r1.summary).toEqual({ status: 'OK', text: 'You are down mostly on options.', reason: null });
    expect(repo.save).toHaveBeenCalledTimes(1);
    await svc.get(owner, {}, new Date(NOW.getTime() + 5 * 60_000));
    expect(repo.listTrackers).toHaveBeenCalledTimes(1);
    await svc.get(owner, { refresh: true }, new Date(NOW.getTime() + 6 * 60_000));
    expect(repo.listTrackers).toHaveBeenCalledTimes(2);
  });

  it('a stored review younger than 15 minutes is served after a restart', async () => {
    const { svc, repo } = setup();
    const stored = await setup().svc.get(owner, {}, NOW);
    repo.latestSince.mockResolvedValue({ id: 'old', review: stored });
    const r = await svc.get(owner, {}, NOW);
    expect(r).toBe(stored);
    expect(repo.listTrackers).not.toHaveBeenCalled();
  });

  it('daily-candle trend per holding; tags from it', async () => {
    const { svc, feeds } = setup();
    const r = await svc.get(owner, {}, NOW);
    expect(feeds?.fetchCandles).toHaveBeenCalledWith('owner', '1', 'NSE', '1d', expect.any(Date), NOW);
    expect(r.holdings[0].trend.status).toBe('OK');
    expect(r.holdings[0].tags).toEqual(expect.arrayContaining(['DEAD-MONEY', 'WEAK-TREND']));
  });

  it('fails open: candle error → NO_DATA; busy model → BUSY; non-owner → SKIPPED; no model → SKIPPED', async () => {
    const a = await setup({ candles: 'throw', llm: 'busy' }).svc.get(owner, {}, NOW);
    expect(a.holdings[0].trend.status).toBe('NO_DATA');
    expect(a.holdings[0].trend.reason).toMatch(/NO_FEED_SESSION/);
    expect(a.summary.status).toBe('BUSY');
    expect(a.suggestions.length).toBeGreaterThan(0);

    const b = setup({ llm: 'denied', candles: 'none' });
    const rb = await b.svc.get({ userId: 'someone', role: 'USER' }, {}, NOW);
    expect(rb.summary.status).toBe('SKIPPED');
    expect(b.llm?.complete).not.toHaveBeenCalled();

    const c = await setup({ llm: 'none' }).svc.get(owner, {}, NOW);
    expect(c.summary.status).toBe('SKIPPED');
  });

  it('a store failure does not fail the request', async () => {
    const { svc, repo } = setup();
    repo.save.mockRejectedValue(new Error('relation "portfolio_reviews" does not exist'));
    const r = await svc.get(owner, {}, NOW);
    expect(r.headline.trades).toBe(1);
  });
});
