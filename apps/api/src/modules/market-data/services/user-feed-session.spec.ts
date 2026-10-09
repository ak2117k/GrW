import { UserFeedSession } from './user-feed-session';
import { AngelThrottleError } from './angel-throttle';
import type { FeedState } from './user-feed.types';

function makeDeps() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const ws = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    fetchData: jest.fn(),
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
    }),
    handlers,
  };
  const wsFactory = jest.fn().mockReturnValue(ws);
  const smartApi = {
    generateSession: jest.fn().mockResolvedValue({
      data: { jwtToken: 'jwt', feedToken: 'feed' },
    }),
    logout: jest.fn().mockResolvedValue(undefined),
    getCandleData: jest.fn().mockResolvedValue({
      data: [
        ['2026-05-15T09:15:00+05:30', 100, 110, 90, 105, 1000],
        ['2026-05-15T09:16:00+05:30', 105, 108, 104, 106, 500],
      ],
    }),
    marketData: jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            symbolToken: '111',
            tradingSymbol: 'FOO-EQ',
            ltp: 250.5,
            open: 248,
            high: 252,
            low: 247,
            close: 249,
            tradeVolume: 4242,
            opnInterest: 77,
          },
        ],
      },
    }),
  };
  // Vault lease that just hands fake decrypted creds to the callback.
  const withCreds = jest.fn(async (_userId: string, cb: (c: any) => Promise<any>) =>
    cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' }),
  );
  return { ws, wsFactory, smartApi, withCreds };
}

it('connects using per-user feedToken and marks state live', async () => {
  const d = makeDeps();
  const states: FeedState[] = [];
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  s.onState((st) => states.push(st));
  await s.ensureConnected();
  expect(d.wsFactory).toHaveBeenCalledWith(
    expect.objectContaining({ jwttoken: 'jwt', feedtype: 'feed', clientcode: 'C1', apikey: 'k' }),
  );
  expect(states).toContain('live');
});

it('ensureConnected is idempotent (single login/socket)', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.ensureConnected();
  expect(d.smartApi.generateSession).toHaveBeenCalledTimes(1);
  expect(d.wsFactory).toHaveBeenCalledTimes(1);
});

it('tracks active token count across subscribe/unsubscribe', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.subscribe([{ token: '111', exchange: 'NSE' }, { token: '222', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(2);
  await s.unsubscribe([{ token: '111', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(1);
  expect(d.ws.fetchData).toHaveBeenCalled(); // subscribe issued a fetchData
});

it('reconnect emits reconnecting → live with NO intervening connecting', async () => {
  jest.useFakeTimers();
  try {
    const d = makeDeps();
    const states: FeedState[] = [];
    const s = new UserFeedSession('u1', {
      withDecryptedCreds: d.withCreds,
      smartApiFactory: () => d.smartApi as any,
      wsFactory: d.wsFactory as any,
    });
    s.onState((st) => states.push(st));
    await s.ensureConnected(); // first connect: connecting → live

    // Socket drops → onSocketDown('reconnecting') + schedules a reconnect.
    d.ws.handlers['close']();
    // Advance past the first backoff (1000ms) so the reconnect timer fires and
    // the shared-promise re-login runs to completion.
    await jest.advanceTimersByTimeAsync(1000);

    const recIdx = states.indexOf('reconnecting');
    expect(recIdx).toBeGreaterThanOrEqual(0);
    const liveAfterRec = states.indexOf('live', recIdx + 1);
    expect(liveAfterRec).toBeGreaterThan(recIdx);
    // Crucially: no 'connecting' between reconnecting and the following live,
    // otherwise the client's reconnecting → live gap-fill never fires.
    expect(states.slice(recIdx, liveAfterRec + 1)).not.toContain('connecting');
    // Shared-promise routing means exactly one re-login for the reconnect.
    expect(d.smartApi.generateSession).toHaveBeenCalledTimes(2); // initial + reconnect
  } finally {
    jest.useRealTimers();
  }
});

it('getCandles connects then returns mapped candles from the user session', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  // 8h window on a 1m interval → single chunk (no inter-chunk delay).
  const from = new Date('2026-05-15T03:45:00.000Z'); // 09:15 IST
  const to = new Date('2026-05-15T05:45:00.000Z'); // 11:15 IST
  const candles = await s.getCandles('111', 'NSE', '1m', from, to);

  expect(d.smartApi.generateSession).toHaveBeenCalledTimes(1); // ensureConnected ran
  expect(d.smartApi.getCandleData).toHaveBeenCalledWith(
    expect.objectContaining({
      exchange: 'NSE',
      symboltoken: '111',
      interval: 'ONE_MINUTE',
    }),
  );
  expect(candles).toHaveLength(2);
  expect(candles[0].open).toBe(100);
  expect(candles[1].close).toBe(106);
  // ascending by timestamp
  expect(candles[0].timestamp.getTime()).toBeLessThanOrEqual(candles[1].timestamp.getTime());
});

it('getCandles RETRIES a transient data:null throttle and keeps the candles', async () => {
  // data:null is Angel's THROTTLE shape, not "no data". Treating it as an
  // empty chunk (the previous behaviour) turned every throttled window into a
  // permanent, silent hole in the chart — the "missing candles" bug.
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValueOnce({ data: null });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const from = new Date('2026-05-15T03:45:00.000Z');
  const to = new Date('2026-05-15T05:45:00.000Z');
  const candles = await s.getCandles('111', 'NSE', '1m', from, to);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(2); // throttled, then retried
  expect(candles).toHaveLength(2);
}, 15_000);

it('getCandles degrades to [] (no throw) when the throttle never clears', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ data: null });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const from = new Date('2026-05-15T03:45:00.000Z');
  const to = new Date('2026-05-15T05:45:00.000Z');
  const candles = await s.getCandles('111', 'NSE', '1m', from, to);
  expect(candles).toEqual([]);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
}, 15_000);

it('getCandles does NOT retry a genuine empty window (data:[])', async () => {
  // A holiday or pre-listing window must resolve immediately, not burn the
  // retry budget against a broker that is answering correctly.
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ data: [] });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const from = new Date('2026-05-15T03:45:00.000Z');
  const to = new Date('2026-05-15T05:45:00.000Z');
  const candles = await s.getCandles('111', 'NSE', '1m', from, to);
  expect(candles).toEqual([]);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(1);
});

it('getCandles serves 1w from ONE_DAY bars aggregated into IST weeks', async () => {
  // '1w' is not an Angel interval — sending it literally came back data:null
  // and the weekly chart rendered empty. It must be fetched as ONE_DAY and
  // rolled up locally.
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({
    data: [
      // Week of Mon 3 Aug 2026 (IST)
      ['2026-08-03T00:00:00+05:30', 100, 112, 98, 105, 1000],
      ['2026-08-04T00:00:00+05:30', 105, 120, 103, 118, 2000],
      // Week of Mon 10 Aug 2026 — partial (Monday only), still emitted.
      ['2026-08-10T00:00:00+05:30', 118, 125, 117, 124, 3000],
    ],
  });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const from = new Date('2026-06-15T00:00:00.000Z');
  const to = new Date('2026-08-14T00:00:00.000Z');
  const candles = await s.getCandles('111', 'NSE', '1w', from, to);

  expect(d.smartApi.getCandleData).toHaveBeenCalledWith(
    expect.objectContaining({ symboltoken: '111', interval: 'ONE_DAY' }),
  );
  expect(candles).toHaveLength(2);
  expect(candles[0].timestamp.getTime()).toBe(Date.parse('2026-08-03T00:00:00+05:30'));
  expect(candles[0].open).toBe(100);
  expect(candles[0].high).toBe(120);
  expect(candles[0].low).toBe(98);
  expect(candles[0].close).toBe(118);
  expect(candles[0].volume).toBe(3000);
  expect(candles[1].timestamp.getTime()).toBe(Date.parse('2026-08-10T00:00:00+05:30'));
  expect(candles[1].close).toBe(124);
}, 15_000);

it('getCandles widens the 1w daily window past the caller’s narrow request', async () => {
  // The chart sizes its window for the timeframe it asked for (~730 days for
  // 1w), which is barely a hundred weekly bars. The daily fetch is floored at
  // 5 years so the weekly chart has history to draw.
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ data: [] });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const to = new Date('2026-08-14T00:00:00.000Z');
  const from = new Date('2026-07-14T00:00:00.000Z'); // one month — far too narrow
  await s.getCandles('111', 'NSE', '1w', from, to);

  // 5 * 365 = 1825 days at ONE_DAY's 1800-day cap → 2 chunks.
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(2);
  const oldest = d.smartApi.getCandleData.mock.calls
    .map((c: any[]) => c[0].fromdate as string)
    .sort()[0];
  expect(oldest < '2021-09' && oldest > '2021-07').toBe(true);
}, 15_000);

it('getQuote connects then returns a mapped FULL quote', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const quote = await s.getQuote('111', 'NSE');
  expect(d.smartApi.generateSession).toHaveBeenCalledTimes(1); // ensureConnected ran
  expect(d.smartApi.marketData).toHaveBeenCalledWith({
    mode: 'FULL',
    exchangeTokens: { NSE: ['111'] },
  });
  expect(quote).not.toBeNull();
  expect(quote!.token).toBe('111');
  expect(quote!.ltp).toBe(250.5);
  expect(quote!.oi).toBe(77);
});

it('getQuote returns null when nothing is fetched', async () => {
  const d = makeDeps();
  d.smartApi.marketData.mockResolvedValueOnce({ data: { fetched: [] } });
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  const quote = await s.getQuote('111', 'NSE');
  expect(quote).toBeNull();
});

it('dispose closes the socket and logs out', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.dispose();
  expect(d.ws.close).toHaveBeenCalled();
  expect(d.smartApi.logout).toHaveBeenCalled();
});


function makeSession(d = makeDeps()) {
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  return { s, d };
}

it('subscribes NFO and BFO tokens on their own exchange types', async () => {
  const { s, d } = makeSession();
  await s.subscribe([
    { token: '35001', exchange: 'NFO' },
    { token: '850001', exchange: 'BFO' },
  ]);
  const types = d.ws.fetchData.mock.calls.map((c: any[]) => c[0].exchangeType).sort();
  expect(types).toEqual([2, 4]);
});

it('treats the same token on two exchanges as two subscriptions', async () => {
  const { s } = makeSession();
  await s.subscribe([
    { token: '1', exchange: 'NSE' },
    { token: '1', exchange: 'MCX' },
  ]);
  expect(s.activeTokenCount()).toBe(2);
  await s.unsubscribe([{ token: '1', exchange: 'MCX' }]);
  expect(s.activeTokenCount()).toBe(1);
});

it('stamps each tick with its exchange from exchange_type', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({ token: '"35001"', exchange_type: 2, last_traded_price: 25050 });
  expect(ticks[0]).toMatchObject({ token: '35001', exchange: 'NFO', ltp: 250.5 });
});

it('carries SNAP_QUOTE best-five depth on the tick, in rupees', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({
    token: '"2885"',
    exchange_type: 1,
    last_traded_price: 150050,
    close_price: 149000,
    best_5_buy_data: [{ flag: 1, quantity: 10, price: 150040, no_of_orders: 2 }],
    best_5_sell_data: [{ flag: 0, quantity: 4, price: 150060, no_of_orders: 1 }],
  });
  expect(ticks[0]).toMatchObject({
    token: '2885',
    exchange: 'NSE',
    ltp: 1500.5,
    close: 1490,
    depth: { bids: [{ price: 1500.4, qty: 10, orders: 2 }], asks: [{ price: 1500.6, qty: 4, orders: 1 }] },
  });
});

it('a tick with no best-five data has no depth field', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({ token: '"99926000"', exchange_type: 1, last_traded_price: 2500000 });
  expect(ticks[0]).not.toHaveProperty('depth');
});

// smartapi-javascript resolves (never rejects) HTTP errors as { status, message }
// with no `data`; Angel One signals rate limits with HTTP 403.
it('getQuotes treats an SDK-resolved HTTP 403 as a throttle', async () => {
  const d = makeDeps();
  d.smartApi.marketData.mockResolvedValue({ status: 403, message: 'Forbidden' });
  const { s } = makeSession(d);
  await expect(
    s.getQuotes([{ token: '1', exchange: 'NSE' }], { throwOnThrottle: true }),
  ).rejects.toBeInstanceOf(AngelThrottleError);
});

it('getQuotes reports other broker failures as errors, not throttles', async () => {
  const d = makeDeps();
  d.smartApi.marketData.mockResolvedValue({ status: 401, message: 'Unauthorized' });
  const { s } = makeSession(d);
  const err = await s
    .getQuotes([{ token: '1', exchange: 'NSE' }], { throwOnThrottle: true })
    .catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AngelThrottleError);
  expect(String(err.message)).toMatch(/401/);
});

it('getQuotes throws AngelThrottleError on data:null only when asked to', async () => {
  const d = makeDeps();
  d.smartApi.marketData.mockResolvedValue({ data: null, message: 'Access denied because of exceeding access rate' });
  const { s } = makeSession(d);
  await expect(s.getQuotes([{ token: '1', exchange: 'NSE' }])).resolves.toEqual(new Map());
  await expect(
    s.getQuotes([{ token: '1', exchange: 'NSE' }], { throwOnThrottle: true }),
  ).rejects.toBeInstanceOf(AngelThrottleError);
});

it('getCandleWindow makes exactly ONE getCandleData call for the window', async () => {
  const { s, d } = makeSession();
  const from = new Date('2026-05-15T03:45:00.000Z'); // 09:15 IST
  const to = new Date('2026-05-15T10:00:00.000Z'); // 15:30 IST
  const candles = await s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', from, to);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(1);
  expect(d.smartApi.getCandleData).toHaveBeenCalledWith({
    exchange: 'NSE',
    symboltoken: '111',
    interval: 'ONE_MINUTE',
    fromdate: '2026-05-15 09:15',
    todate: '2026-05-15 15:30',
  });
  expect(candles).toHaveLength(2);
});

it('getCandleWindow rejects a throttle with AngelThrottleError and never retries', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ data: null, message: 'Access denied because of exceeding access rate' });
  const { s } = makeSession(d);
  await expect(s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', new Date(0), new Date(60_000))).rejects.toBeInstanceOf(AngelThrottleError);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(1);
});

it('getCandleWindow reports an SDK-resolved 401 as an error, and [] as genuinely empty', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValueOnce({ status: 401, message: 'Unauthorized' });
  const { s } = makeSession(d);
  const err = await s.getCandleWindow('111', 'NSE', 'ONE_DAY', new Date(0), new Date(1)).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AngelThrottleError);
  d.smartApi.getCandleData.mockResolvedValueOnce({ data: [] });
  await expect(s.getCandleWindow('111', 'NSE', 'ONE_DAY', new Date(0), new Date(1))).resolves.toEqual([]);
});

it('getCandleWindow reports a body-level errorcode (AG8001) as an error, not a throttle', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ status: false, message: 'Invalid Token', errorcode: 'AG8001', data: null });
  const { s } = makeSession(d);
  const err = await s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', new Date(0), new Date(60_000)).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AngelThrottleError);
});

// Production 2026-10-09: chart, chart-context (several timeframes), sentinel and scoring all
// fetched history on the owner's ONE session at once. The 350 ms gap only spaced chunks
// WITHIN one getCandles call, so concurrent calls burst past Angel's 3 req/s historical
// limit → 403 → 1 s/2 s retries → dropped chunks → 5–85 s chart loads.
describe('session-wide historical pacing', () => {
  function timedSession() {
    const d = makeDeps();
    const at: number[] = [];
    d.smartApi.getCandleData.mockImplementation(async () => {
      at.push(Date.now());
      return { data: [['2026-05-15T09:15:00+05:30', 1, 1, 1, 1, 1]] };
    });
    return { ...makeSession(d), at };
  }
  const from = new Date('2026-05-15T03:45:00.000Z');
  const to = new Date('2026-05-15T05:45:00.000Z');

  it('spaces concurrent getCandles calls at least 350 ms apart across the whole session', async () => {
    const { s, at } = timedSession();
    await s.ensureConnected();
    await Promise.all([
      s.getCandles('111', 'NSE', '1m', from, to),
      s.getCandles('222', 'NSE', '1m', from, to),
      s.getCandles('333', 'NSE', '1m', from, to),
    ]);
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(340);
  });

  it('getCandleWindow (the market hub) shares the same pacing as getCandles', async () => {
    const { s, at } = timedSession();
    await s.ensureConnected();
    await Promise.all([
      s.getCandles('111', 'NSE', '1m', from, to),
      s.getCandleWindow('222', 'NSE', 'ONE_MINUTE', from, to),
    ]);
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(340);
  });

  it('a failing call does not stall the calls queued behind it', async () => {
    const { s, at, d } = timedSession();
    await s.ensureConnected();
    d.smartApi.getCandleData.mockImplementationOnce(async () => {
      at.push(Date.now());
      return { status: 401, message: 'Unauthorized' };
    });
    const results = await Promise.allSettled([
      s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', from, to),
      s.getCandleWindow('222', 'NSE', 'ONE_MINUTE', from, to),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(at).toHaveLength(2);
  });
});
