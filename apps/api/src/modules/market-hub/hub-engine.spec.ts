import { CandleBuilder } from './candles/candle-builder';
import { HubEngine } from './hub-engine';
import { SessionClock } from './session-clock';
import { FakeBroker } from './testing/fake-broker';
import { MemoryCandleRepo } from './testing/memory-candle-repo';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import type { InstrumentRef } from './hub.types';

const IST = (local: string) => new Date(new Date(`${local}Z`).getTime() - 5.5 * 3600_000).getTime();
const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' };
const POS: InstrumentRef = { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' };

function engine(broker = new FakeBroker()) {
  const e = new HubEngine({
    broker,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    cap: 50,
    defaults: [NIFTY],
  });
  return { e, broker };
}

describe('HubEngine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00'));
  });
  afterEach(() => jest.useRealTimers());

  it('connects and subscribes the default context set on start', async () => {
    const { e, broker } = engine();
    await e.start();
    expect(broker.connected).toBe(true);
    expect(broker.subscribed.has('NSE:99926000')).toBe(true);
    e.stop();
  });

  it('watches open positions at priority 0 and drops closed ones', async () => {
    const { e, broker } = engine();
    await e.start();
    await e.setPositions([POS]);
    expect(broker.subscribed.has('NFO:35001')).toBe(true);
    await e.setPositions([]);
    expect(broker.subscribed.has('NFO:35001')).toBe(false);
    e.stop();
  });

  it('answers price() from the book with the right result kind', async () => {
    const { e, broker } = engine();
    await e.start();
    expect(e.price(POS, { maxAgeMs: 5000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    await e.setPositions([POS]);
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    expect(e.price(POS, { maxAgeMs: 5000 }).kind).toBe('fresh');
    jest.setSystemTime(Date.now() + 6000);
    expect(e.price(POS, { maxAgeMs: 5000 }).kind).toBe('stale');
    e.stop();
  });

  it('keeps running when the broker is down at start, and subscribes once it recovers', async () => {
    const broker = new FakeBroker();
    let down = true;
    broker.connect = async () => {
      if (down) throw new Error('login failed');
      broker.connected = true;
    };
    const realSubscribe = broker.subscribe.bind(broker);
    broker.subscribe = async (refs) => {
      if (down) throw new Error('not connected');
      return realSubscribe(refs);
    };
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const { e } = engine(broker);
    await expect(e.start()).resolves.toBeUndefined();
    expect(e.status().watched).toBe(1); // the context set is registered regardless
    expect(e.status().lastError).toMatch(/not connected|login failed/);
    down = false;
    await jest.advanceTimersByTimeAsync(30_000); // maintenance tick retries
    expect(broker.subscribed.has('NSE:99926000')).toBe(true);
    expect(e.status().lastError).toBeNull();
    await Promise.resolve();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    e.stop();
  });

  it('reports a status snapshot with the oldest P0 price age and unpriced P0 count', async () => {
    const { e, broker } = engine();
    await e.start();
    await e.setPositions([POS]);
    let s = e.status();
    expect(s.prices.unpricedP0).toBe(1);
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    jest.setSystemTime(Date.now() + 1500);
    s = e.status();
    expect(s.prices.unpricedP0).toBe(0);
    expect(s.prices.oldestP0AgeMs).toBe(1500);
    expect(s.slots.live).toBe(2);
    expect(s.calendar.missingYear).toBeNull();
    e.stop();
  });

  function engineWithCandles(broker = new FakeBroker(), repo = new MemoryCandleRepo()) {
    const e = new HubEngine({
      broker,
      clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      cap: 50,
      defaults: [NIFTY],
      candles: { repo },
    });
    return { e, broker, repo };
  }

  it('has no candle status and refuses candles() when candles are not enabled', async () => {
    const { e } = engine();
    await e.start();
    expect(e.status().candles).toBeNull();
    expect(e.candlesEnabled).toBe(false);
    await expect(e.candles(NIFTY, '1m', 0, 1)).rejects.toThrow(/not enabled/);
    e.stop();
  });

  it('turns live ticks into a tick-sourced 1m bar once the minute closes', async () => {
    const { e, broker, repo } = engineWithCandles();
    await e.start();
    jest.setSystemTime(IST('2026-10-07T10:00:10'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 100, 'NSE'), volume: 1000 });
    jest.setSystemTime(IST('2026-10-07T10:00:40'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 101, 'NSE'), volume: 1300 });
    jest.setSystemTime(IST('2026-10-07T10:01:05'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 102, 'NSE'), volume: 1350 });
    await jest.advanceTimersByTimeAsync(5000);
    const bars = await repo.read('1m', NIFTY, IST('2026-10-07T10:00:00'), IST('2026-10-07T10:01:00'));
    expect(bars).toEqual([{ ts: IST('2026-10-07T10:00:00'), open: 100, high: 101, low: 100, close: 101, volume: 300 }]);
    expect(e.status().candles).toMatchObject({ tickBarsWritten: 1, tickWriteFailures: 0, building: 1 });
    e.stop();
  });

  it('stop() writes the minutes that have ended and never the forming one', async () => {
    const stopAt = async (local: string) => {
      jest.setSystemTime(IST('2026-10-07T10:00:00'));
      const { e, broker, repo } = engineWithCandles();
      await e.start();
      jest.setSystemTime(IST('2026-10-07T10:00:10'));
      broker.emitTick(FakeBroker.tick('99926000', 100, 'NSE'));
      jest.setSystemTime(IST(local));
      e.stop();
      await jest.advanceTimersByTimeAsync(0);
      return repo.read('1m', NIFTY, IST('2026-10-07T10:00:00'), IST('2026-10-07T10:02:00'));
    };
    // 10:00 has ended (inside the close grace): written on stop.
    expect((await stopAt('2026-10-07T10:01:01')).map((b) => b.ts)).toEqual([IST('2026-10-07T10:00:00')]);
    // 10:00 is still forming: never stored.
    expect(await stopAt('2026-10-07T10:00:50')).toEqual([]);
  });

  it('flushBars never rejects, even when closing due bars throws; it counts a write failure', async () => {
    const { e } = engineWithCandles();
    await e.start();
    const spy = jest.spyOn(CandleBuilder.prototype, 'closeDue').mockImplementation(() => {
      throw new Error('builder broke');
    });
    // White-box: flushBars is private and runs from a timer as `void`, where a rejection is unhandled.
    const flush = (e as unknown as { flushBars(now: number): Promise<void> }).flushBars.bind(e);
    await expect(flush(Date.now())).resolves.toBeUndefined();
    expect(e.status().candles).toMatchObject({ tickWriteFailures: 1 });
    spy.mockRestore();
    e.stop();
  });

  it('counts a failed tick-bar write instead of throwing', async () => {
    const repo = new MemoryCandleRepo();
    repo.failWrites = true;
    const { e, broker } = engineWithCandles(new FakeBroker(), repo);
    await e.start();
    broker.emitTick(FakeBroker.tick('99926000', 100, 'NSE'));
    jest.setSystemTime(IST('2026-10-07T10:01:05'));
    broker.emitTick(FakeBroker.tick('99926000', 101, 'NSE'));
    await jest.advanceTimersByTimeAsync(5000);
    expect(e.status().candles).toMatchObject({ tickBarsWritten: 0, tickWriteFailures: 1 });
    e.stop();
  });

  it('candles() fills through the broker’s candles endpoint under the Governor', async () => {
    const { e, broker } = engineWithCandles();
    await e.start();
    const p = e.candles(NIFTY, '1m', IST('2026-10-06T00:00:00'), IST('2026-10-07T00:00:00'));
    await jest.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r).toEqual({ candles: [], incomplete: [] });
    expect(broker.candleCalls.map((c) => c.interval)).toEqual(['ONE_MINUTE']);
    expect(e.status().governor.endpoints.candles.callsLastMin).toBe(1);
    e.stop();
  });

  it('runFixup covers tick instruments and watched instruments and records the report', async () => {
    const { e, broker, repo } = engineWithCandles();
    await e.start();
    await repo.upsert('1m', { exchange: 'NSE', token: '2885', symbol: '2885' }, [
      { ts: IST('2026-10-06T10:00:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ], 'tick');
    const p = e.runFixup('2026-10-06');
    await jest.advanceTimersByTimeAsync(60_000);
    const report = await p;
    expect(report).toMatchObject({ day: '2026-10-06', instruments: 2, calls: 6 }); // NIFTY (watched) + 2885 (tick)
    expect(new Set(broker.candleCalls.map((c) => c.ref.token))).toEqual(new Set(['99926000', '2885']));
    expect(e.status().candles?.lastFixup).toEqual(report);
    e.stop();
  });
});
