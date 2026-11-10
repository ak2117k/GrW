import { SignalContextService, TREND_TIMEOUT_MS } from './signal-context.service';
import { missingBlocks } from '../../self-review/decisions/detectors';

/** market.trend: database reads only, boxed, and a failure is `unavailable` with the reason (never thrown). */
const NOW = new Date('2026-11-10T09:00:00Z');
const Q = 15 * 60_000;
const rising = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + 0.01 * i * i;
    return { ts: NOW.getTime() - (n + 1 - i) * Q, open: c - 0.1, high: c + 0.3, low: c - 0.4, close: c };
  });

function make(repoOver: Record<string, unknown> = {}) {
  const repo = {
    underlyingRef: jest.fn(async () => ({ exchange: 'NSE', token: '99926000', symbol: 'Nifty 50' })),
    hub15mBars: jest.fn(async () => rising(200)),
    stored15mBars: jest.fn(async () => []),
    ...repoOver,
  };
  const feeds = { fetchCandles: jest.fn(), fetchQuote: jest.fn(), fetchOptionGreeks: jest.fn() };
  const svc = new SignalContextService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, feeds as any, undefined, repo as any);
  return { svc, repo, feeds };
}
const sig = (side: 'BUY' | 'SELL', kind: 'CE' | 'PE' = 'CE') => ({ underlying: 'NIFTY', instrumentKind: kind, side });

describe('SignalContextService.trend — record-only trend tag block', () => {
  it('present with the tag and raw numbers, from candles_1m rolled to 15m; never the broker', async () => {
    const { svc, repo, feeds } = make();
    const b = await svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW });
    expect(b.status).toBe('present');
    const v = (b as { value: Record<string, unknown> }).value;
    expect(v).toMatchObject({ tag: 'WITH', direction: 'BULL', trend: 'UP', timeframe: '15m', candleCount: 200, computedAt: NOW.toISOString() });
    expect(v.source).toContain('candles_1m Nifty 50');
    expect(repo.underlyingRef).toHaveBeenCalledWith('NIFTY', 'NFO', NOW);
    expect(feeds.fetchCandles).not.toHaveBeenCalled();
    expect(missingBlocks('judge', { trend: b })).toEqual([]);
  });

  it('one bar read per underlying per quarter-hour (the decision row and the judge packet share it)', async () => {
    const { svc, repo } = make();
    const a = await svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW });
    const b = await svc.trend({ signal: sig('BUY', 'PE'), exchange: 'NFO', now: new Date(NOW.getTime() + 60_000) });
    expect(repo.hub15mBars).toHaveBeenCalledTimes(1);
    expect((a as any).value.tag).toBe('WITH');
    expect((b as any).value.tag).toBe('AGAINST');
  });

  it('stored 15m history fills in when the hub has too few bars; too few overall ⇒ UNKNOWN (present)', async () => {
    const all = rising(200);
    const { svc } = make({ hub15mBars: jest.fn(async () => all.slice(150)), stored15mBars: jest.fn(async () => all.slice(0, 150)) });
    const b = await svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW });
    expect((b as any).value).toMatchObject({ tag: 'WITH', candleCount: 200 });
    const thin = make({ hub15mBars: jest.fn(async () => all.slice(150)) });
    const u = await thin.svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW });
    expect(u.status).toBe('present');
    expect((u as any).value).toMatchObject({ tag: 'UNKNOWN', candleCount: 50, reason: expect.stringContaining('need 120') });
  });

  it('a failed read is unavailable with the reason; no price line is unavailable too', async () => {
    const { svc } = make({ hub15mBars: jest.fn(async () => { throw new Error('relation "candles_1m" does not exist'); }) });
    expect(await svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW })).toEqual({ status: 'unavailable', reason: expect.stringContaining('candles_1m') });
    const none = make({ underlyingRef: jest.fn(async () => null) });
    expect(await none.svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW })).toEqual({ status: 'unavailable', reason: expect.stringContaining('no price line for the underlying NIFTY') });
  });

  it(`a slow read is cut at ${TREND_TIMEOUT_MS} ms and reported unavailable`, async () => {
    jest.useFakeTimers();
    try {
      const { svc } = make({ hub15mBars: jest.fn(() => new Promise(() => undefined)) });
      const p = svc.trend({ signal: sig('BUY'), exchange: 'NFO', now: NOW });
      await jest.advanceTimersByTimeAsync(TREND_TIMEOUT_MS + 1);
      expect(await p).toEqual({ status: 'unavailable', reason: expect.stringContaining(`timed out after ${TREND_TIMEOUT_MS} ms`) });
    } finally {
      jest.useRealTimers();
    }
  });
});
