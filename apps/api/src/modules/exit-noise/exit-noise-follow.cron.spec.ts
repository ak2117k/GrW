import { BROKER_CALLS_PER_SWEEP, COVER_MIN_BARS, ExitNoiseFollowCron, barsInWindow, covers, followUp } from './exit-noise-follow.cron';

const MIN = 60_000;
/** Prod 2026-11-02: the RELIANCE real exit (NSE 2885), whose candles_1m stop at 09:50 IST. */
const EXIT = new Date('2026-11-02T04:18:23.457Z');
const bar = (min: number, close: number, high = close, low = close) => ({ at: new Date(EXIT.getTime() + min * MIN), high, low, close, volume: 0 });
/** Broker candles (UserFeedManager.fetchCandles shape) for minutes `from..to` after the exit, bar-start stamped. */
const candles = (from: number, to: number, px = (m: number) => 1237 + m) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const m = from + i;
    return { timestamp: new Date(Math.floor((EXIT.getTime() + m * MIN) / MIN) * MIN), open: px(m), high: px(m) + 0.5, low: px(m) - 0.5, close: px(m), volume: 100 };
  });
const fullBars = () => Array.from({ length: 30 }, (_, i) => bar(i + 1, 1237 + i));
const row = (id: string, token = '2885') => ({ id, want: 'BULLISH', exitAt: EXIT, underlyingAtExit: 1237.1, underlyingExchange: 'NSE', underlyingToken: token });

function setup(opts: { rows?: ReturnType<typeof row>[]; bars?: (token: string) => unknown[]; fetch?: jest.Mock; noFeeds?: boolean } = {}) {
  const repo = {
    unfollowed: jest.fn(async () => opts.rows ?? [row('r')]),
    minuteBars: jest.fn(async (_e: string, token: string) => (opts.bars ? opts.bars(token) : [bar(1, 1237), bar(2, 1238)])),
    setFollow: jest.fn(async () => undefined),
  };
  const fetchCandles = opts.fetch ?? jest.fn(async () => candles(0, 31));
  const cron = new ExitNoiseFollowCron(repo as never, opts.noFeeds ? undefined : ({ fetchCandles } as never));
  cron.sleep = jest.fn(async () => undefined);
  return { repo, fetchCandles, cron };
}

describe('coverage rule', () => {
  it('needs a +15 and a +30 close and COVER_MIN_BARS bars in the window', () => {
    const full = fullBars();
    expect(barsInWindow(EXIT, full)).toBe(30);
    expect(covers(followUp('BULLISH', EXIT, 1237.1, full), 30)).toBe(true);
    // RELIANCE 2026-11-02: two bars right after the exit, then nothing.
    const frag = [bar(1, 1237), bar(2, 1238)];
    expect(covers(followUp('BULLISH', EXIT, 1237.1, frag), barsInWindow(EXIT, frag))).toBe(false);
    // Both marks but a hole in the middle.
    const holey = [bar(1, 1), ...Array.from({ length: COVER_MIN_BARS - 3 }, (_, i) => bar(14 + i, 2)), bar(30, 3)];
    expect(covers(followUp('BULLISH', EXIT, 1, holey), barsInWindow(EXIT, holey))).toBe(false);
  });
});

describe('ExitNoiseFollowCron.sweep — broker fallback', () => {
  const now = new Date(EXIT.getTime() + 40 * MIN);
  beforeEach(() => (process.env.HUB_OWNER_USER_ID = 'owner-1'));
  afterEach(() => delete process.env.HUB_OWNER_USER_ID);

  it('candles_1m covers the window: no broker call, source candles_1m', async () => {
    const t = setup({ bars: () => fullBars() });
    expect(await t.cron.sweep(now)).toBe(1);
    expect(t.fetchCandles).not.toHaveBeenCalled();
    const [id, f, , src] = t.repo.setFollow.mock.calls[0] as unknown as [string, ReturnType<typeof followUp>, Date, Record<string, unknown>];
    expect(id).toBe('r');
    expect(f).toMatchObject({ after15m: 1251, after30m: 1266 });
    expect(src).toEqual({ source: 'candles_1m', bars: 30 });
  });

  it('candles_1m gap: the owner session 1m history fills +15 / +30 on the read underlying line', async () => {
    const t = setup();
    expect(await t.cron.sweep(now)).toBe(1);
    expect(t.fetchCandles).toHaveBeenCalledTimes(1);
    const [owner, token, exchange, tf, from, to] = t.fetchCandles.mock.calls[0] as unknown as [string, string, string, string, Date, Date];
    expect([owner, token, exchange, tf]).toEqual(['owner-1', '2885', 'NSE', '1m']);
    expect(from.getTime()).toBe(EXIT.getTime() - MIN);
    expect(to.getTime()).toBe(EXIT.getTime() + 31 * MIN);
    const [, f, , src] = t.repo.setFollow.mock.calls[0] as unknown as [string, ReturnType<typeof followUp>, Date, Record<string, unknown>];
    // Bar-start stamps: the +15 mark (04:33:23) is nearest the 04:33 bar = exit minute + 15.
    expect(f.after15m).toBe(1252);
    expect(f.after30m).toBe(1267);
    expect(f.maxFavour30m).toBeGreaterThan(0);
    expect(src).toMatchObject({ source: 'broker', bars: 30, candles1mBars: 2 });
  });

  it('broker throws: the row stays pending, is not re-fetched within 15 min, and is retried after', async () => {
    const fetch = jest.fn(async () => {
      throw new Error('AngelThrottleError');
    });
    const t = setup({ fetch });
    expect(await t.cron.sweep(now)).toBe(0);
    expect(t.repo.setFollow).not.toHaveBeenCalled();
    expect(await t.cron.sweep(new Date(now.getTime() + 5 * MIN))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.repo.setFollow).not.toHaveBeenCalled();
    fetch.mockImplementationOnce(async () => candles(0, 31) as never);
    expect(await t.cron.sweep(new Date(now.getTime() + 15 * MIN))).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((t.repo.setFollow.mock.calls[0] as unknown[])[3]).toMatchObject({ source: 'broker' });
  });

  it('broker empty answer: pending (not-yet-available)', async () => {
    const t = setup({ fetch: jest.fn(async () => []) });
    expect(await t.cron.sweep(now)).toBe(0);
    expect(t.repo.setFollow).not.toHaveBeenCalled();
  });

  it('caps broker calls per sweep and spaces them', async () => {
    const rows = Array.from({ length: BROKER_CALLS_PER_SWEEP + 3 }, (_, i) => row(`r${i}`, `t${i}`));
    const t = setup({ rows, bars: () => [] });
    expect(await t.cron.sweep(now)).toBe(BROKER_CALLS_PER_SWEEP);
    expect(t.fetchCandles).toHaveBeenCalledTimes(BROKER_CALLS_PER_SWEEP);
    expect(t.cron.sleep).toHaveBeenCalledTimes(BROKER_CALLS_PER_SWEEP - 1);
    // The rest are left for the next sweep.
    expect(t.repo.setFollow.mock.calls.map((c) => (c as unknown[])[0])).toEqual(rows.slice(0, BROKER_CALLS_PER_SWEEP).map((r) => r.id));
  });

  it('a past window whose session closed inside it: a non-empty broker answer is final without +30', async () => {
    const t = setup({ bars: () => [], fetch: jest.fn(async () => candles(0, 10)) });
    expect(await t.cron.sweep(new Date(EXIT.getTime() + 50 * MIN))).toBe(1);
    const [, f, , src] = t.repo.setFollow.mock.calls[0] as unknown as [string, ReturnType<typeof followUp>, Date, Record<string, unknown>];
    expect(f.after30m).toBeNull();
    expect(src).toMatchObject({ source: 'broker', bars: 10 });
  });

  it('after a day the read is closed with what candles_1m had', async () => {
    const t = setup({ fetch: jest.fn(async () => []) });
    expect(await t.cron.sweep(new Date(EXIT.getTime() + (24 * 60 - 5) * MIN))).toBe(1);
    expect((t.repo.setFollow.mock.calls[0] as unknown[])[3]).toMatchObject({ source: 'candles_1m', bars: 2, partial: true });
  });

  it('no owner configured: no broker call, closes on partial candles_1m as before', async () => {
    delete process.env.HUB_OWNER_USER_ID;
    const t = setup();
    expect(await t.cron.sweep(now)).toBe(1);
    expect(t.fetchCandles).not.toHaveBeenCalled();
    expect((t.repo.setFollow.mock.calls[0] as unknown[])[3]).toMatchObject({ source: 'candles_1m', partial: true });
  });

  it('no UserFeedManager: same pre-broker behaviour', async () => {
    const t = setup({ noFeeds: true, bars: () => [] });
    expect(await t.cron.sweep(now)).toBe(0);
    expect(t.repo.setFollow).not.toHaveBeenCalled();
  });
});
