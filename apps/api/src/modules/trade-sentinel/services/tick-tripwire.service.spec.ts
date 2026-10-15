import { TickSensorBook, type SensorSeed } from './tick-sensor-book';
import { TickTripwireService, tickFires } from './tick-tripwire.service';

const seed = (over: Partial<SensorSeed> = {}): SensorSeed => ({
  userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2624000CE', segment: 'OPT', side: 'LONG', entryPrice: 100,
  contractKey: 'NFO:1', underlyingKey: 'NSE:99926000', nearestSupport: 24000, nearestResistance: 24200,
  holdingHigh: 130, holdingLow: 95, ltp: 120, underlyingLtp: 24050, ...over,
});

function harness(book = new TickSensorBook()) {
  const runner = { wakeForTick: jest.fn() };
  const subs = new Map<string, (t: { key: string; ltp: number; at: number }) => void>();
  const stream = { subscribe: jest.fn((u: string, fn: never) => { subs.set(u, fn); return () => subs.delete(u); }) };
  const svc = new TickTripwireService(book, runner as never, stream as never);
  return { svc, book, runner, stream, subs };
}

let intervalSpy: jest.SpyInstance;
beforeEach(() => { intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never); });
afterEach(() => jest.restoreAllMocks());

describe('tickFires', () => {
  it('level break on the underlying (scale-safe)', () => {
    expect(tickFires({ ...seed(), underlyingLtp: 23990, lastEvalAt: 0, firing: false }).map((f) => f.name)).toEqual(['level-break']);
  });
  it('giveback on the premium', () => {
    expect(tickFires({ ...seed(), ltp: 105, lastEvalAt: 0, firing: false }).map((f) => f.name)).toEqual(['giveback-off-peak']);
  });
  it('quiet', () => expect(tickFires({ ...seed(), lastEvalAt: 0, firing: false })).toEqual([]));
});

describe('TickTripwireService', () => {
  it('a rising-edge level break wakes the user’s cycle once; staying broken does not re-wake', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).toHaveBeenCalledWith('u1', 'level-break on NIFTY28OCT2624000CE');
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23980, at: 2 }, 11_500);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('evaluates at most once per second per tracker', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 24050, at: 1 }, 10_000);  // quiet, evaluated
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 2 }, 10_400);  // within 1 s: price recorded, not evaluated
    expect(h.runner.wakeForTick).not.toHaveBeenCalled();
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 3 }, 11_100);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('per-user wake cooldown 15 s across trackers', () => {
    const h = harness();
    h.book.upsert(seed());
    h.book.upsert(seed({ trackerId: 't2', contractKey: 'NFO:2' }));
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
    h.svc.onTick('u1', { key: 'NFO:2', ltp: 105, at: 2 }, 12_000);   // t2 gives back — inside the cooldown
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('a premium tick raises the running peak used by giveback', () => {
    const h = harness();
    h.book.upsert(seed({ holdingHigh: 120 }));
    h.svc.onTick('u1', { key: 'NFO:1', ltp: 140, at: 1 }, 10_000);
    expect(h.book.forKey('NFO:1')[0].holdingHigh).toBe(140);
  });

  it('another user’s tick never touches this user’s trackers', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u2', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).not.toHaveBeenCalled();
  });

  it.each([
    ['shadow off', { shadow: false, tickTripwires: true }],
    ['tick tripwires off', { shadow: true, tickTripwires: false }],
  ])('%s: inert — no timer, no subscription', (_l, cfg) => {
    const h = harness();
    h.book.upsert(seed());
    expect(h.svc.start(cfg)).toBe(false);
    h.svc.subscribeNew();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(h.stream.subscribe).not.toHaveBeenCalled();
  });

  it('on: subscribes each user in the book once', () => {
    const h = harness();
    h.book.upsert(seed());
    expect(h.svc.start({ shadow: true, tickTripwires: true })).toBe(true);
    h.svc.subscribeNew();
    h.svc.subscribeNew();
    expect(h.stream.subscribe).toHaveBeenCalledTimes(1);
    h.subs.get('u1')!({ key: 'NSE:99926000', ltp: 23990, at: Date.now() });
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('releases a user’s hub subscription once the book no longer holds them, and re-subscribes when they return', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.start({ shadow: true, tickTripwires: true });
    h.svc.subscribeNew();
    expect(h.subs.has('u1')).toBe(true);
    h.book.prune('u1', new Set());
    h.svc.subscribeNew();
    expect(h.subs.has('u1')).toBe(false);
    h.book.upsert(seed());
    h.svc.subscribeNew();
    expect(h.stream.subscribe).toHaveBeenCalledTimes(2);
    expect(h.subs.has('u1')).toBe(true);
  });
});
