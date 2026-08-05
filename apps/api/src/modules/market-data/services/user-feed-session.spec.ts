import { UserFeedSession } from './user-feed-session';
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
