import { holdingCheck } from '../domain/review.fixtures';
import { BrokerBudget, PlanDataService, SCREEN_MAX_CANDLE_FETCHES, SCREEN_MAX_OI_FETCHES } from './plan-data.service';

const NOW = new Date('2026-11-02T08:00:00.000Z');
const day = (i: number) => new Date(NOW.getTime() - (260 - i) * 86_400_000);

/** 260 rising daily candles ending at `end` (a strong uptrend near its high). */
const rising = (end = 200) =>
  Array.from({ length: 260 }, (_, i) => {
    const c = end * (0.6 + (0.4 * i) / 259);
    return { timestamp: day(i).toISOString(), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 };
  });

function setup(opts: { funds?: 'ok' | 'throw' | 'none'; oi?: 'ok' | 'throw'; stocks?: number } = {}) {
  const futures = new Map<string, { name: string; instrumentId: string; token: string; expiry: Date }>();
  futures.set('NIFTY', { name: 'NIFTY', instrumentId: 'i-n', token: 'fn', expiry: NOW });
  for (let i = 0; i < (opts.stocks ?? 3); i++) futures.set(`S${i}`, { name: `S${i}`, instrumentId: `i${i}`, token: `f${i}`, expiry: NOW });
  futures.set('HELD', { name: 'HELD', instrumentId: 'ih', token: 'fh', expiry: NOW });
  const repo = {
    latestMargin: jest.fn().mockResolvedValue({ asOf: new Date(NOW.getTime() - 86_400_000), availableCash: 1234 }),
    futuresByName: jest.fn().mockResolvedValue(futures),
    cashLines: jest.fn(async (names: string[]) => new Map(names.map((n) => [n, `c-${n}`]))),
    sectors: jest.fn(async (names: string[]) => new Map(names.map((n, i) => [n, `Sector${i}`]))),
    newsFor: jest.fn().mockResolvedValue(new Map()),
    eventsFor: jest.fn().mockResolvedValue(new Map()),
    futuresTurnover: jest.fn(async (ids: string[]) => new Map(ids.map((id, i) => [id, 1000 - i]))),
    futuresOiDaily: jest.fn().mockResolvedValue([
      { date: '2026-10-27', close: 100, oi: 1000 },
      { date: '2026-10-28', close: 101, oi: 1050 },
      { date: '2026-10-29', close: 103, oi: 1100 },
    ]),
  };
  const bars = rising();
  const oiPts = bars.slice(-10).map((b, i) => ({ ts: new Date(b.timestamp), oi: 1000 + i * 40 }));
  const feeds = {
    fetchCandles: jest.fn().mockResolvedValue(bars),
    fetchOIWindow: opts.oi === 'throw' ? jest.fn().mockRejectedValue(new Error('AB1004')) : jest.fn().mockResolvedValue(oiPts),
  };
  const overview =
    opts.funds === 'none'
      ? undefined
      : { getFunds: opts.funds === 'throw' ? jest.fn().mockRejectedValue(new Error('reconnecting')) : jest.fn().mockResolvedValue({ availableCash: 4827.82, net: 4827.82, utilisedMargin: 0 }) };
  const svc = new PlanDataService(repo as never, feeds as never, overview as never);
  svc.spacingMs = 0;
  return { svc, repo, feeds, overview };
}

describe('PlanDataService', () => {
  it('balance: live RMS → last-known snapshot → NO_DATA', async () => {
    expect((await setup().svc.balance('u', new BrokerBudget(), NOW)).status).toBe('LIVE');
    const lk = await setup({ funds: 'throw' }).svc.balance('u', new BrokerBudget(), NOW);
    expect(lk).toMatchObject({ status: 'LAST_KNOWN', availableCash: 1234, reason: 'reconnecting' });
    const s = setup({ funds: 'none' });
    s.repo.latestMargin.mockResolvedValue({ asOf: new Date(NOW.getTime() - 30 * 86_400_000), availableCash: 1 });
    expect((await s.svc.balance('u', new BrokerBudget(), NOW)).status).toBe('NO_DATA');
  });

  it('the broker-call cap is hard: nothing is fetched once it is used up', async () => {
    const { svc, feeds } = setup();
    const budget = new BrokerBudget(1);
    const hs = [holdingCheck({ symbol: 'A-EQ', token: 'a' }), holdingCheck({ symbol: 'B-EQ', token: 'b' })];
    const r = await svc.holdingsEvidence('u', hs, budget, NOW);
    expect(feeds.fetchCandles).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
    expect(r.trends.get('b')?.status).toBe('NO_DATA');
    expect(r.trends.get('b')?.reason).toMatch(/cap/);
  });

  it('daily candles are cached per token per IST day (a second run spends no call)', async () => {
    const { svc, feeds } = setup();
    const hs = [holdingCheck({ symbol: 'A-EQ', token: 'a' })];
    await svc.holdingsEvidence('u', hs, new BrokerBudget(), NOW);
    const b2 = new BrokerBudget();
    await svc.holdingsEvidence('u', hs, b2, new Date(NOW.getTime() + 3_600_000));
    expect(feeds.fetchCandles).toHaveBeenCalledTimes(1);
    expect(b2.used).toBe(0);
  });

  it('futures OI for an F&O holding from the broker; falls back to the OI capture; NOT_FNO otherwise', async () => {
    const a = setup();
    const ev = await a.svc.holdingsEvidence('u', [holdingCheck({ symbol: 'S0-EQ', token: 's0', ltp: 200 }), holdingCheck({ symbol: 'CASHONLY-EQ', token: 'x' })], new BrokerBudget(), NOW);
    expect(ev.evidence.get('s0')?.oi).toMatchObject({ source: 'BROKER', status: 'SUPPORTIVE', buildup: 'LONG_BUILDUP' });
    expect(ev.evidence.get('x')?.oi.status).toBe('NOT_FNO');
    expect(ev.evidence.get('s0')?.trend).toBe('STRONG_UP');
    expect(ev.evidence.get('s0')?.sector).toBe('Sector0');

    const b = setup({ oi: 'throw' });
    const ev2 = await b.svc.holdingsEvidence('u', [holdingCheck({ symbol: 'S0-EQ', token: 's0', ltp: 200 })], new BrokerBudget(), NOW);
    expect(ev2.evidence.get('s0')?.oi).toMatchObject({ source: 'SNAPSHOTS', status: 'SUPPORTIVE' });
  });

  it('screen: skips index futures and held names, caps candle and OI fetches, returns candidates with evidence', async () => {
    const { svc, feeds } = setup({ stocks: 60 });
    const budget = new BrokerBudget();
    const r = await svc.screen('u', new Set(['HELD']), budget, NOW);
    expect(r.stats.universe).toBe(61); // 60 + HELD, NIFTY excluded
    const fetchedTokens = feeds.fetchCandles.mock.calls.map((c) => c[1]);
    expect(fetchedTokens).not.toContain('c-HELD');
    expect(fetchedTokens).not.toContain('c-NIFTY');
    expect(feeds.fetchCandles).toHaveBeenCalledTimes(SCREEN_MAX_CANDLE_FETCHES);
    expect(feeds.fetchOIWindow.mock.calls.length).toBeLessThanOrEqual(SCREEN_MAX_OI_FETCHES);
    expect(r.candidates.length).toBe(SCREEN_MAX_OI_FETCHES);
    expect(r.candidates[0].evidence.trend).toBe('STRONG_UP');
    expect(r.candidates[0].evidence.oi.status).toBe('SUPPORTIVE');
    expect(budget.used).toBeLessThanOrEqual(budget.cap);
  }, 30_000);
});
