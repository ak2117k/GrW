import { parseMbmConfig } from '../mbm.config';
import { MbmTickBarsService } from './mbm-tick-bars.service';

const T0 = Date.parse('2026-10-23T08:00:00Z'); // 13:30 IST

function build(env: NodeJS.ProcessEnv = { MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner' }) {
  let nowMs = T0;
  const tickFns: Array<(u: string, t: unknown) => void> = [];
  const stateFns: Array<(u: string, s: string) => void> = [];
  const feeds = {
    addTickListener: jest.fn((fn) => tickFns.push(fn)),
    addStateListener: jest.fn((fn) => stateFns.push(fn)),
    pin: jest.fn().mockResolvedValue(undefined),
  };
  const bars = { insertTickBars: jest.fn(async (_s: string, b: unknown[]) => b.length) };
  const svc = new MbmTickBarsService(parseMbmConfig(env), () => new Date(nowMs), feeds as never, bars as never);
  svc.onModuleInit();
  const tick = (user: string, token: string, ltp: number, atMs: number, exchange = 'NSE') => {
    nowMs = atMs;
    for (const fn of tickFns) fn(user, { token, exchange, ltp, timestamp: new Date(atMs) });
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return { svc, feeds, bars, tick, stateFns, flush, setNow: (ms: number) => (nowMs = ms) };
}

describe('MbmTickBarsService', () => {
  it('builds NIFTY bars from the owner’s ticks and inserts only complete minutes (no new subscription in listen mode)', async () => {
    const { feeds, bars, tick, flush } = build();
    for (let sec = -3; sec <= 60; sec++) tick('owner', '99926000', 25_000 + sec, T0 + sec * 1000);
    tick('someone-else', '99926000', 1, T0 + 61_000);
    await flush();
    expect(bars.insertTickBars).toHaveBeenCalledTimes(1);
    expect(bars.insertTickBars).toHaveBeenCalledWith('NIFTY', [
      { timestamp: new Date(T0), open: 25_000, high: 25_059, low: 25_000, close: 25_059, volume: 0 },
    ]);
    expect(feeds.pin).not.toHaveBeenCalled();
  });

  it('tracks INDIAVIX and BANKNIFTY too, ignores stock tokens as bars but counts them as heartbeat', async () => {
    const { bars, tick, flush } = build();
    tick('owner', '99926017', 14.5, T0 - 2000);
    tick('owner', '99926009', 55_000, T0 - 1000);
    tick('owner', '99926017', 14.6, T0 + 1000);
    tick('owner', '99926009', 55_010, T0 + 2000);
    for (let sec = 5; sec <= 60; sec += 5) tick('owner', '2885', 1400, T0 + sec * 1000); // RELIANCE
    tick('owner', '2885', 1400, T0 + 62_000);
    await flush();
    expect(bars.insertTickBars.mock.calls.map((c) => c[0]).sort()).toEqual(['BANKNIFTY', 'INDIAVIX']);
  });

  it('a socket state change resets the builder (the minute in flight is dropped)', async () => {
    const { bars, tick, stateFns, flush } = build();
    for (let sec = -3; sec <= 30; sec++) tick('owner', '99926000', 25_000, T0 + sec * 1000);
    for (const fn of stateFns) fn('owner', 'reconnecting');
    for (let sec = 31; sec <= 61; sec++) tick('owner', '99926000', 25_000, T0 + sec * 1000);
    await flush();
    expect(bars.insertTickBars).not.toHaveBeenCalled();
  });

  it('buckets by receive time when the exchange timestamp is skewed', async () => {
    const { bars, svc, setNow, flush } = build();
    const at = (sec: number) => {
      setNow(T0 + sec * 1000);
      svc.onTick({ token: '99926000', exchange: 'NSE', ltp: 25_000, timestamp: new Date(0) } as never);
    };
    for (let sec = -3; sec <= 61; sec++) at(sec);
    await flush();
    expect(bars.insertTickBars).toHaveBeenCalledWith('NIFTY', [expect.objectContaining({ timestamp: new Date(T0) })]);
  });

  it('a failed insert is logged, never thrown into the feed', async () => {
    const { bars, tick, flush } = build();
    bars.insertTickBars.mockRejectedValueOnce(new Error('db down'));
    for (let sec = -3; sec <= 61; sec++) expect(() => tick('owner', '99926000', 25_000, T0 + sec * 1000)).not.toThrow();
    await flush();
    expect(bars.insertTickBars).toHaveBeenCalled();
  });

  it('pin mode pins the three index tokens on the owner session; off / MBM off register nothing', async () => {
    const pin = build({ MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner', MBM_TICK_BARS: 'pin' });
    await pin.svc.ensurePinned();
    expect(pin.feeds.pin).toHaveBeenCalledWith('owner', [
      { token: '99926000', exchange: 'NSE' },
      { token: '99926009', exchange: 'NSE' },
      { token: '99926017', exchange: 'NSE' },
    ]);
    const listen = build();
    await listen.svc.ensurePinned();
    expect(listen.feeds.pin).not.toHaveBeenCalled();
    for (const env of [{ MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner', MBM_TICK_BARS: 'off' }, { MBM_FEED_USER_ID: 'owner' }]) {
      const off = build(env);
      expect(off.feeds.addTickListener).not.toHaveBeenCalled();
    }
  });
});
