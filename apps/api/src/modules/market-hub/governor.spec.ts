import { DEFAULT_RATES, Governor, type GovernorOptions } from './governor';
import { LANE } from './hub.types';
import { AngelThrottleError } from '../market-data/services/angel-throttle';

function opts(over: Partial<GovernorOptions> = {}): GovernorOptions {
  return {
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => false,
    isThrottle: (e) => e instanceof AngelThrottleError,
    ...over,
  };
}

describe('Governor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => jest.useRealTimers());

  it('spaces calls to one endpoint by its budget (quote 5/s → 200 ms)', async () => {
    const gov = new Governor(opts());
    const at: number[] = [];
    const run = async () => {
      at.push(Date.now());
      return 1;
    };
    const all = Promise.all([0, 1, 2].map(() => gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run })));
    await jest.advanceTimersByTimeAsync(1000);
    await all;
    expect(at).toEqual([0, 200, 400]);
  });

  it('serves a higher lane first when the endpoint frees up', async () => {
    const gov = new Governor(opts());
    const order: string[] = [];
    const sub = (name: string, lane: 0 | 1 | 2 | 3) =>
      gov.submit({ endpoint: 'quote', lane, run: async () => void order.push(name) });
    const a = sub('first', LANE.ROUTINE);
    const b = sub('routine', LANE.ROUTINE);
    const c = sub('critical', LANE.CRITICAL);
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['first', 'critical', 'routine']);
  });

  it('merges identical in-flight requests into one broker call', async () => {
    const gov = new Governor(opts());
    const run = jest.fn(async () => 42);
    const req = { endpoint: 'candles' as const, lane: LANE.INTERACTIVE, key: 'NSE:1:1m', run };
    const [x, y] = await Promise.all([gov.submit(req), gov.submit(req)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(x).toEqual({ kind: 'ok', value: 42 });
    expect(y).toEqual({ kind: 'ok', value: 42 });
  });

  it('backs off a throttled endpoint 1 s, then 2 s, and reports Throttled', async () => {
    const gov = new Governor(opts());
    const at: number[] = [];
    let n = 0;
    const run = async () => {
      at.push(Date.now());
      n++;
      if (n <= 2) throw new AngelThrottleError('rate');
      return 'ok';
    };
    const req = { endpoint: 'candles' as const, lane: LANE.ROUTINE, run };
    expect(await gov.submit(req)).toEqual({ kind: 'throttled', retryAfterMs: 1000 });
    const p2 = gov.submit(req);
    await jest.advanceTimersByTimeAsync(999);
    expect(at).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p2).toEqual({ kind: 'throttled', retryAfterMs: 2000 });
    const p3 = gov.submit(req);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await p3).toEqual({ kind: 'ok', value: 'ok' });
    expect(at).toEqual([0, 1000, 3000]);
  });

  it('caps back-off at maxBackoffMs', async () => {
    const gov = new Governor(opts({ maxBackoffMs: 3000 }));
    const run = async () => {
      throw new AngelThrottleError('rate');
    };
    const req = { endpoint: 'greek' as const, lane: LANE.ROUTINE, run };
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const p = gov.submit(req);
      await jest.advanceTimersByTimeAsync(5000);
      results.push(await p);
    }
    expect(results.map((r: any) => r.retryAfterMs)).toEqual([1000, 2000, 3000, 3000]);
  });

  it('gives up on an interactive request after its deadline with busy', async () => {
    const gov = new Governor(opts({ ratesPerSec: { ...DEFAULT_RATES, quote: 0.1 } }));
    const run = jest.fn(async () => 1);
    await gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run }); // occupies 10 s
    const waiting = gov.submit({ endpoint: 'quote', lane: LANE.INTERACTIVE, run });
    await jest.advanceTimersByTimeAsync(5000);
    expect(await waiting).toEqual({ kind: 'busy' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs background work only when lanes 0–2 are empty, and trickles it in market hours', async () => {
    const gov = new Governor(opts({ isMarketHours: () => true }));
    const at: Record<string, number> = {};
    const mark = (name: string) => async () => void (at[name] = Date.now());
    const r1 = gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run: mark('r1') }); // runs at 0
    const r2 = gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run: mark('r2') }); // waits to 200
    const bg1 = gov.submit({ endpoint: 'candles', lane: LANE.BACKGROUND, run: mark('bg1') });
    const bg2 = gov.submit({ endpoint: 'candles', lane: LANE.BACKGROUND, run: mark('bg2') });
    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.all([r1, r2, bg1, bg2]);
    expect(at.r2).toBe(200);
    expect(at.bg1).toBe(200); // only after r2 left the queue
    expect(at.bg2).toBe(5200); // trickle: ≤ 1 per 5 s in market hours
  });

  it('returns other failures as error without backing off', async () => {
    const gov = new Governor(opts());
    const boom = new Error('boom');
    const res = await gov.submit({
      endpoint: 'search',
      lane: LANE.ROUTINE,
      run: async () => {
        throw boom;
      },
    });
    expect(res).toEqual({ kind: 'error', error: boom });
    expect(gov.metrics().endpoints.search.backoffMs).toBe(0);
  });

  it('prunes call timestamps older than an hour even if metrics() is never read', async () => {
    const gov = new Governor(opts());
    const run = async () => 1;
    await gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run });
    jest.setSystemTime(60 * 60 * 1000 + 1);
    await gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run });
    // White-box on purpose: the leak is internal and invisible through metrics().
    const calls = (gov as any).endpoints.get('quote').calls as number[];
    expect(calls).toEqual([60 * 60 * 1000 + 1]);
  });

  it('reports lane depth, waits and endpoint counters', async () => {
    const gov = new Governor(opts());
    const run = async () => 1;
    const all = Promise.all([0, 1].map(() => gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run })));
    expect(gov.metrics().lanes[LANE.ROUTINE].depth).toBe(1);
    await jest.advanceTimersByTimeAsync(500);
    await all;
    const m = gov.metrics();
    expect(m.endpoints.quote.callsLastMin).toBe(2);
    expect(m.lanes[LANE.ROUTINE].waitP95Ms).toBe(200);
  });
});
