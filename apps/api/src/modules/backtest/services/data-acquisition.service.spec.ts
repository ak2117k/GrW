import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { DataAcquisitionService, dailyStamp, keepBars } from './data-acquisition.service';

const D = (iso: string) => new Date(iso);
// Saturday 2026-10-24 12:00 IST: off-hours. Friday 2026-10-23 10:00 IST: market hours.
const SATURDAY = D('2026-10-24T06:30:00Z');
const MARKET_HOURS = D('2026-10-23T04:30:00Z');

function setup(opts: { now?: Date; env?: Record<string, string>; usedToday?: number; dataset?: any; complete?: boolean } = {}) {
  const env = opts.env ?? {};
  const config = { get: (k: string) => env[k] } as any;
  let span: any = opts.dataset ?? null;
  const repo = {
    findDataset: jest.fn(async () => span),
    ensureDataset: jest.fn(async (_s: string, _e: string, interval: string, source: string) => {
      span = span ?? { id: 1, symbol: 'NIFTY', exchange: 'NSE', interval, fromTs: null, toTs: null, rows: 0, source };
      return span;
    }),
    refreshStats: jest.fn(async () => span ?? { fromTs: null, toTs: null }),
    insertBars: jest.fn(async (_id: number, bars: any[]) => bars.length),
    callsSince: jest.fn(async () => opts.usedToday ?? 0),
    createFetchJob: jest.fn(async () => ({ id: 'job1' })),
    updateFetchJob: jest.fn(async () => ({})),
  };
  const data = { coverage: jest.fn(async () => ({ complete: !!opts.complete, dataset: opts.complete ? span : null })) };
  const instruments = { searchInstruments: jest.fn(async () => []) };
  const windows: Array<{ from: Date; to: Date }> = [];
  const feeds = {
    fetchCandleWindow: jest.fn(async (_u: string, _ref: any, _i: string, from: Date, to: Date) => {
      windows.push({ from, to });
      return [{ timestamp: from, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    }),
  };
  const yahoo = {
    getCandles: jest.fn(async () => [{ timestamp: D('2026-09-01T03:45:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]),
  };
  const sleep = jest.fn(async () => undefined);
  const svc = new DataAcquisitionService(
    config, repo as any, data as any, instruments as any, feeds as any, yahoo as any,
    () => opts.now ?? SATURDAY, sleep,
  );
  return { svc, repo, feeds, yahoo, sleep, windows, instruments };
}

const SEPT = { symbol: 'NIFTY', exchange: 'NSE', timeframe: '15m', from: D('2026-08-31T18:30:00Z'), to: D('2026-09-30T18:30:00Z') };

describe('DataAcquisitionService', () => {
  it('noop when the catalogue already covers the request', async () => {
    const { svc, feeds } = setup({ complete: true, dataset: { id: 1, interval: '1m', source: 'research-1m', fromTs: D('2016-10-03'), toTs: D('2026-10-19') } });
    const r = await svc.acquire('owner', SEPT);
    expect(r.status).toBe('noop');
    expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
  });

  it('off-hours: one Angel call per NSE session, newest first, over the owner session (token map)', async () => {
    const { svc, feeds, windows, repo } = setup();
    const r = await svc.acquire('owner', SEPT);
    expect(r.provider).toBe('angel');
    expect(r.calls).toBe(windows.length);
    expect(windows.length).toBeGreaterThanOrEqual(20);
    expect(windows.length).toBeLessThanOrEqual(22);
    expect(windows[0].from.getTime()).toBeGreaterThan(windows[1].from.getTime()); // newest first
    expect(feeds.fetchCandleWindow.mock.calls[0][0]).toBe('owner');
    expect(feeds.fetchCandleWindow.mock.calls[0][1]).toEqual({ token: '99926000', exchange: 'NSE' });
    expect(feeds.fetchCandleWindow.mock.calls[0][2]).toBe('FIFTEEN_MINUTE');
    expect(r.rows).toBe(windows.length);
    expect(repo.updateFetchJob).toHaveBeenCalledWith('job1', expect.objectContaining({ calls: r.calls, provider: 'angel' }));
  });

  it('stops at the per-request cap and reports partial', async () => {
    const { svc, windows } = setup({ env: { BACKTEST_FETCH_MAX_CALLS: '5' } });
    const r = await svc.acquire('owner', SEPT);
    expect(windows).toHaveLength(5);
    expect(r.calls).toBe(5);
    expect(r.status).toBe('partial');
    expect(r.message).toMatch(/cap \(5 calls\)/);
  });

  it('market hours: allowed but capped (30) and paced 1.5 s apart', async () => {
    const { svc, windows, sleep } = setup({ now: MARKET_HOURS });
    const r = await svc.acquire('owner', { ...SEPT, from: D('2026-06-30T18:30:00Z') });
    expect(windows).toHaveLength(30);
    expect(r.status).toBe('partial');
    expect(r.message).toMatch(/after 15:45 IST/);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('daily cap reached: refused without a broker call', async () => {
    const { svc, feeds } = setup({ usedToday: 1500 });
    const r = await svc.acquire('owner', SEPT);
    expect(r.status).toBe('refused');
    expect(r.message).toMatch(/daily Angel fetch cap/);
    expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
  });

  it('daily cap reached on 1d: falls back to Yahoo daily', async () => {
    const { svc, feeds, yahoo } = setup({ usedToday: 1500 });
    const r = await svc.acquire('owner', { ...SEPT, symbol: 'RELIANCE', timeframe: '1d' });
    expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
    expect(yahoo.getCandles).toHaveBeenCalledWith('RELIANCE', 'NSE', '2885', '1d', SEPT.from, SEPT.to);
    expect(r.provider).toBe('yahoo');
    expect(r.rows).toBe(1);
  });

  it('a Yahoo-sourced daily series is extended from Yahoo (never mixed with unadjusted Angel bars)', async () => {
    const { svc, feeds, yahoo } = setup({
      dataset: { id: 7, symbol: 'ABB', exchange: 'NSE', interval: '1d', fromTs: D('2016-10-21'), toTs: D('2026-10-21'), rows: 2471, source: 'yahoo' },
    });
    const r = await svc.acquire('owner', { symbol: 'ABB', exchange: 'NSE', timeframe: '1d', from: D('2010-01-01'), to: D('2026-10-21') });
    expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
    expect(yahoo.getCandles).toHaveBeenCalled();
    expect(r.provider).toBe('yahoo');
  });

  it('retries a throttled window (each retry counts as a call)', async () => {
    const { svc, feeds, sleep } = setup({ env: { BACKTEST_FETCH_MAX_CALLS: '3' } });
    feeds.fetchCandleWindow.mockRejectedValueOnce(new AngelThrottleError('rate'));
    const r = await svc.acquire('owner', SEPT);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(r.calls).toBe(3);
    expect(r.rows).toBe(2);
  });

  it('a broker error stops cleanly with what was fetched kept', async () => {
    const { svc, feeds } = setup();
    feeds.fetchCandleWindow
      .mockResolvedValueOnce([{ timestamp: D('2026-09-30T03:45:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 0 }] as any)
      .mockRejectedValueOnce(new Error('Invalid token'));
    const r = await svc.acquire('owner', SEPT);
    expect(r.status).toBe('partial');
    expect(r.calls).toBe(2);
    expect(r.message).toMatch(/Invalid token/);
  });

  it('refuses a symbol it cannot map to a token', async () => {
    const { svc, feeds } = setup();
    const r = await svc.acquire('owner', { ...SEPT, symbol: 'NOSUCH' });
    expect(r.status).toBe('refused');
    expect(feeds.fetchCandleWindow).not.toHaveBeenCalled();
  });

  it('one acquisition at a time', async () => {
    const { svc, feeds } = setup();
    let release!: () => void;
    feeds.fetchCandleWindow.mockImplementationOnce(() => new Promise((r) => { release = () => r([] as any); }));
    const first = svc.acquire('owner', SEPT);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const second = await svc.acquire('owner', SEPT);
    expect(second.status).toBe('refused');
    expect(second.message).toMatch(/another data fetch/);
    release();
    await first;
  });
});

describe('bar normalisation', () => {
  it('daily bars are stamped 09:15 IST of their session date', () => {
    expect(dailyStamp(D('2026-09-01T18:30:00Z')).toISOString()).toBe('2026-09-02T03:45:00.000Z'); // IST midnight of 09-02
    expect(dailyStamp(D('2026-09-01T03:45:00Z')).toISOString()).toBe('2026-09-01T03:45:00.000Z');
  });
  it('intraday bars outside the window or the session are dropped', () => {
    const w = { from: D('2026-09-01T03:45:00Z'), to: D('2026-09-01T10:00:00Z') };
    const mk = (iso: string) => ({ timestamp: D(iso), open: 1, high: 1, low: 1, close: 1, volume: 0 });
    const kept = keepBars([mk('2026-09-01T03:44:00Z'), mk('2026-09-01T03:45:00Z'), mk('2026-09-01T10:00:00Z')], w, '1m');
    expect(kept.map((b) => b.timestamp.toISOString())).toEqual(['2026-09-01T03:45:00.000Z']);
  });
});
