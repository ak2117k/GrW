import { HubEngine } from './hub-engine';
import { SessionClock } from './session-clock';
import { FakeBroker } from './testing/fake-broker';
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
});
