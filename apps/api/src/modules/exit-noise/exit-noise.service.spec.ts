import { ExitNoiseReadService, packetFacts } from './exit-noise.service';
import { ExitNoiseFollowCron, followUp } from './exit-noise-follow.cron';

const MIN = 60_000;
const EXIT = new Date('2026-10-30T05:55:20.000Z');

/** The shape of the stored SENSEX look (prod 2026-10-30 05:54 UTC), trimmed. */
const PACKET = {
  position: { symbol: 'SENSEX26N0574500CE', side: 'LONG', underlyingLtp: { available: true, value: 74_489.94, at: '2026-10-30T05:54:00.518Z' } },
  money: { anchors: { best: { ltp: 572.25, underlying: 74_495.69, at: '2026-10-30T05:53:00.044Z' }, floorArm: null, hardExitN: 2 } },
  flow: { noiseUnit: { available: true, value: { contract: null, underlying: { n: 25.83, method: 'atr14-1m', bars: 116 } } } },
  structure: { levelBook: { available: false, reason: 'level book unavailable for this symbol' } },
};

function repo(over: Record<string, jest.Mock> = {}) {
  return {
    contract: jest.fn(async () => ({ name: 'SENSEX', expiry: '2026-11-05', optionType: 'CE' })),
    tracker: jest.fn(async () => ({ userId: 'u', symbol: 'NIFTY04NOV2624000CE', exchange: 'NFO', token: '1', qty: 75 })),
    latestPacket: jest.fn(async () => ({ packet: PACKET, at: new Date('2026-10-30T05:54:08Z') })),
    optionExpiries: jest.fn(async () => []),
    optionContracts: jest.fn(async () => []),
    nearestFuture: jest.fn(async () => null),
    cashRef: jest.fn(async () => null),
    oiRows: jest.fn(async () => []),
    oiLtps: jest.fn(async () => []),
    minuteBars: jest.fn(async () => [{ at: new Date(EXIT.getTime() - MIN), high: 74_470, low: 74_455, close: 74_458.76, volume: 0 }]),
    insert: jest.fn(async () => undefined),
    ...over,
  };
}

const PAPER = {
  source: 'signal_paper' as const,
  refId: 'cmvujr7ef0243t001j5zm0e53',
  exitRule: 'AI_TRIGGER' as const,
  at: EXIT,
  trackerId: 'paper:cmvujr7ef0243t001j5zm0e53',
  tradeId: 'cmvujr7ef0243t001j5zm0e53',
  position: { symbol: 'SENSEX26N0574500CE', exchange: 'BFO', token: '1170000', side: 'LONG' as const },
  exitPrice: 531.3,
  underlyingNow: 74_458.33,
};

describe('packetFacts', () => {
  it('reads the best point, the underlying N, the underlying LTP and VWAP (none without a level book)', () => {
    expect(packetFacts(PACKET)).toEqual({ bestUnderlying: 74_495.69, n: 25.83, underlying: 74_489.94, underlyingAt: '2026-10-30T05:54:00.518Z', vwap: null, vwapSource: 'none' });
    const withBook = { ...PACKET, structure: { levelBook: { available: true, value: { vwap: 74_400 } } } };
    expect(packetFacts(withBook)).toMatchObject({ vwap: 74_400, vwapSource: 'packet level book VWAP' });
    // A zero VWAP (prod NIFTY FUT level books) is no VWAP.
    expect(packetFacts({ structure: { levelBook: { available: true, value: { vwap: 0 } } } }).vwap).toBeNull();
    expect(packetFacts(null)).toMatchObject({ bestUnderlying: null, n: null, underlying: null, vwap: null });
  });
});

describe('ExitNoiseReadService.record', () => {
  afterEach(() => delete process.env.EXIT_NOISE_READS);

  it('stores one row: the position, the underlying line it will be followed on, the verdict and the read', async () => {
    const r = repo();
    const read = await new ExitNoiseReadService(r as never).record(PAPER);
    expect(read?.verdict).toBe('NOISE'); // move (74495.69 − 74458.33) / 25.83 = 1.45 N; nothing else readable
    expect(r.latestPacket).toHaveBeenCalledWith(PAPER.trackerId, true);
    expect(r.minuteBars).toHaveBeenCalledWith('BSE', '99919000', new Date(EXIT.getTime() - 35 * MIN), EXIT);
    const row = (r.insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      source: 'signal_paper', refId: PAPER.refId, symbol: 'SENSEX26N0574500CE', exchange: 'BFO', underlying: 'SENSEX',
      underlyingExchange: 'BSE', underlyingToken: '99919000', side: 'LONG', want: 'BULLISH', exitRule: 'AI_TRIGGER',
      exitPrice: 531.3, exitAt: EXIT, underlyingAtExit: 74_458.33, noiseN: 25.83, verdict: 'NOISE',
    });
    expect(row.read).toMatchObject({ verdict: 'NOISE', packetAt: '2026-10-30T05:54:08.000Z' });
  });

  it('a real exit reads its position from the tracker and keeps the price its caller read', async () => {
    const r = repo({ contract: jest.fn(async () => ({ name: 'NIFTY', expiry: '2026-11-04', optionType: 'CE' })) });
    await new ExitNoiseReadService(r as never).record({ source: 'real', refId: 'v1', exitRule: 'AI_EXIT', at: EXIT, trackerId: 't1', exitPrice: 531.3 });
    expect(r.tracker).toHaveBeenCalledWith('t1');
    expect(r.latestPacket).toHaveBeenCalledWith('t1', false);
    expect((r.insert.mock.calls[0] as unknown[])[0]).toMatchObject({ source: 'real', side: 'LONG', exitPrice: 531.3, underlyingExchange: 'NSE' });
  });

  it('never throws: a failing read is stored as NO_DATA with the error; a failing write is only logged', async () => {
    const r = repo({ contract: jest.fn(async () => { throw new Error('db down'); }) });
    const read = await new ExitNoiseReadService(r as never).record(PAPER);
    expect(read).toMatchObject({ verdict: 'NO_DATA', error: 'db down' });
    expect((r.insert.mock.calls[0] as unknown[])[0]).toMatchObject({ verdict: 'NO_DATA' });
    const w = repo({ insert: jest.fn(async () => { throw new Error('no table'); }) });
    await expect(new ExitNoiseReadService(w as never).record(PAPER)).resolves.toBeNull();
  });

  it('EXIT_NOISE_READS=off: nothing is read or written', async () => {
    process.env.EXIT_NOISE_READS = 'off';
    const r = repo();
    expect(await new ExitNoiseReadService(r as never).record(PAPER)).toBeNull();
    expect(r.contract).not.toHaveBeenCalled();
    expect(r.insert).not.toHaveBeenCalled();
  });
});

describe('follow-up', () => {
  const bar = (min: number, close: number, high = close, low = close) => ({ at: new Date(EXIT.getTime() + min * MIN), high, low, close, volume: 0 });

  it('the closes nearest +15 / +30 min and the excursions over the 30 bars after the exit', () => {
    const bars = [bar(-1, 74_400), bar(1, 74_450, 74_460, 74_445), bar(15, 74_560), bar(22, 74_634, 74_640, 74_600), bar(30, 74_610), bar(31, 75_000)];
    expect(followUp('BULLISH', EXIT, 74_458.33, bars)).toEqual({ after15m: 74_560, after30m: 74_610, maxFavour30m: 181.67, maxAgainst30m: 13.33 });
    expect(followUp('BEARISH', EXIT, 74_458.33, bars)).toMatchObject({ maxFavour30m: 13.33, maxAgainst30m: 181.67 });
    expect(followUp('BULLISH', EXIT, null, bars)).toMatchObject({ maxFavour30m: null, maxAgainst30m: null });
  });

  it('the sweep writes followed rows, retries rows without bars yet, and closes unfollowable rows', async () => {
    const now = new Date(EXIT.getTime() + 40 * MIN);
    const rows = [
      { id: 'a', want: 'BULLISH', exitAt: EXIT, underlyingAtExit: 74_458.33, underlyingExchange: 'BSE', underlyingToken: '99919000' },
      { id: 'b', want: 'BULLISH', exitAt: EXIT, underlyingAtExit: 100, underlyingExchange: 'NSE', underlyingToken: 'nobars' },
      { id: 'c', want: 'BULLISH', exitAt: EXIT, underlyingAtExit: null, underlyingExchange: null, underlyingToken: null },
    ];
    const r = {
      unfollowed: jest.fn(async () => rows),
      minuteBars: jest.fn(async (_e: string, token: string) => (token === 'nobars' ? [] : [bar(15, 74_560), bar(30, 74_610)])),
      setFollow: jest.fn(async () => undefined),
    };
    expect(await new ExitNoiseFollowCron(r as never).sweep(now)).toBe(2);
    expect(r.setFollow.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['a', 'c']);
    expect((r.setFollow.mock.calls[0] as unknown[])[1]).toMatchObject({ after15m: 74_560, after30m: 74_610 });
  });
});
