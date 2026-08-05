import {
  AngelThrottleError,
  HISTORICAL_MIN_GAP_MS,
  HISTORICAL_THROTTLE_RETRY_DELAYS_MS,
  rowsOrThrottle,
  fetchChunksResilient,
} from './angel-throttle';

/** Collects sleeps instead of performing them, so the suite runs instantly. */
function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const W = (start: number, end: number) => ({ start, end });

describe('rowsOrThrottle', () => {
  it('throws AngelThrottleError on data:null — Angel\'s throttle shape', () => {
    expect(() => rowsOrThrottle(null, 'ctx')).toThrow(AngelThrottleError);
    expect(() => rowsOrThrottle(undefined, 'ctx')).toThrow(AngelThrottleError);
  });

  it('returns [] for data:[] — a genuine empty window, NOT a throttle', () => {
    // The distinction is the whole point: a holiday must not be retried, and a
    // throttle must not be mistaken for "this window has no candles".
    expect(rowsOrThrottle([], 'ctx')).toEqual([]);
  });

  it('treats a malformed non-array as empty rather than throttled', () => {
    expect(rowsOrThrottle({ nope: 1 }, 'ctx')).toEqual([]);
    expect(rowsOrThrottle('nope', 'ctx')).toEqual([]);
  });

  it('passes rows through and includes the context in the throttle message', () => {
    expect(rowsOrThrottle([[1, 2]], 'ctx')).toEqual([[1, 2]]);
    expect(() => rowsOrThrottle(null, 'token=99926000 15m')).toThrow(/token=99926000 15m/);
  });
});

describe('fetchChunksResilient', () => {
  it('paces successive chunks by the Angel rate gap, but never before the first', () => {
    // The per-user session used 300ms == 3.33 req/sec against a 3 req/sec
    // limit, so its own loop provoked the throttling that ate candles.
    expect(HISTORICAL_MIN_GAP_MS).toBeGreaterThanOrEqual(1000 / 3);
  });

  it('sleeps the gap between chunks only', async () => {
    const { slept, sleep } = fakeSleep();
    await fetchChunksResilient([W(0, 1), W(1, 2), W(2, 3)], async () => ['x'], { sleep });
    expect(slept).toEqual([HISTORICAL_MIN_GAP_MS, HISTORICAL_MIN_GAP_MS]);
  });

  it('retries a transiently throttled chunk and keeps its candles', async () => {
    const { slept, sleep } = fakeSleep();
    let calls = 0;
    const res = await fetchChunksResilient(
      [W(0, 1)],
      async () => {
        calls++;
        if (calls === 1) throw new AngelThrottleError('throttled');
        return ['recovered'];
      },
      { sleep },
    );
    expect(calls).toBe(2);
    expect(res.items).toEqual(['recovered']);
    expect(res.dropped).toBe(0);
    expect(slept).toContain(HISTORICAL_THROTTLE_RETRY_DELAYS_MS[0]);
  });

  it('drops a persistently throttled chunk but KEEPS the others', async () => {
    // This is the regression that produced missing candles: the old per-user
    // path turned a throttle into an empty chunk with no retry and no log, so
    // the window vanished from the chart permanently and silently.
    const { sleep } = fakeSleep();
    const warnings: string[] = [];
    const res = await fetchChunksResilient(
      [W(0, 1), W(1, 2), W(2, 3)],
      async (start) => {
        if (start === 1) throw new AngelThrottleError('always throttled');
        return [`chunk${start}`];
      },
      { sleep, onWarn: (m) => warnings.push(m) },
    );
    expect(res.items).toEqual(['chunk0', 'chunk2']);
    expect(res.dropped).toBe(1);
    expect(res.attempted).toBe(3);
    // The hole is reported, not swallowed.
    expect(warnings.some((w) => /Dropping throttled chunk/.test(w))).toBe(true);
  });

  it('exhausts exactly the configured retry schedule before dropping', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const res = await fetchChunksResilient(
      [W(0, 1)],
      async () => {
        calls++;
        throw new AngelThrottleError('nope');
      },
      { sleep, retryDelaysMs: [10, 20, 30] },
    );
    expect(calls).toBe(4); // 1 initial + 3 retries
    expect(res.dropped).toBe(1);
  });

  it('does NOT retry a non-throttle error — it propagates immediately', async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    await expect(
      fetchChunksResilient(
        [W(0, 1)],
        async () => {
          calls++;
          throw new Error('auth expired');
        },
        { sleep },
      ),
    ).rejects.toThrow('auth expired');
    expect(calls).toBe(1);
  });

  it('returns [] with no drops for an empty window list', async () => {
    const res = await fetchChunksResilient([], async () => ['x']);
    expect(res).toEqual({ items: [], dropped: 0, attempted: 0 });
  });
});

describe('AngelThrottleError', () => {
  it('is instanceof-able and keeps its name across module boundaries', () => {
    const e = new AngelThrottleError('x');
    expect(e).toBeInstanceOf(AngelThrottleError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AngelThrottleError');
  });

  it('is the SAME class the singleton adapter exports', () => {
    // Both broker paths must agree on `instanceof`, otherwise the per-user
    // session's throttles would be invisible to shared-adapter callers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AngelThrottleError: FromAdapter } = require('./angel-one-adapter.service');
    expect(FromAdapter).toBe(AngelThrottleError);
  });
});
