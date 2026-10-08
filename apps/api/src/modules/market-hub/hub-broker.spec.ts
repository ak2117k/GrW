import { ManagerHubBroker } from './hub-broker';
import type { InstrumentRef } from './hub.types';

function fakeManager() {
  const tickListeners: any[] = [];
  const stateListeners: any[] = [];
  return {
    pin: jest.fn().mockResolvedValue(undefined),
    unpin: jest.fn().mockResolvedValue(undefined),
    fetchQuotes: jest.fn().mockResolvedValue(new Map()),
    addTickListener: jest.fn((fn) => (tickListeners.push(fn), () => undefined)),
    addStateListener: jest.fn((fn) => (stateListeners.push(fn), () => undefined)),
    tickListeners,
    stateListeners,
  };
}
const A: InstrumentRef = { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' };

describe('ManagerHubBroker', () => {
  it('subscribes by pinning on the owner session, never by logging in itself', async () => {
    const m = fakeManager();
    const b = new ManagerHubBroker(m as any, 'owner');
    await b.connect();
    await b.subscribe([A]);
    expect(m.pin).toHaveBeenNthCalledWith(1, 'owner', []);
    expect(m.pin).toHaveBeenNthCalledWith(2, 'owner', [{ token: '35001', exchange: 'NFO' }]);
    await b.unsubscribe([A]);
    expect(m.unpin).toHaveBeenCalledWith('owner', [{ token: '35001', exchange: 'NFO' }]);
  });

  it('asks for throttles to be thrown, not swallowed', async () => {
    const m = fakeManager();
    await new ManagerHubBroker(m as any, 'owner').quotes([A]);
    expect(m.fetchQuotes).toHaveBeenCalledWith('owner', [{ token: '35001', exchange: 'NFO' }], {
      throwOnThrottle: true,
    });
  });

  it('only passes on the owner’s ticks and states', () => {
    const m = fakeManager();
    const b = new ManagerHubBroker(m as any, 'owner');
    const ticks: any[] = [];
    const states: any[] = [];
    b.onTick((t) => ticks.push(t));
    b.onState((s) => states.push(s));
    m.tickListeners[0]('someone-else', { token: '1' });
    m.tickListeners[0]('owner', { token: '2' });
    m.stateListeners[0]('owner', 'live');
    expect(ticks).toEqual([{ token: '2' }]);
    expect(states).toEqual(['live']);
  });
});

it('candles() fetches one window on the owner’s session and maps to hub candles', async () => {
  const manager = {
    pin: jest.fn(), unpin: jest.fn(), fetchQuotes: jest.fn(), addTickListener: jest.fn(), addStateListener: jest.fn(),
    fetchCandleWindow: jest.fn().mockResolvedValue([
      { timestamp: new Date('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 },
    ]),
  };
  const b = new ManagerHubBroker(manager as any, 'owner');
  const from = new Date('2026-10-06T18:30:00.000Z');
  const to = new Date('2026-10-07T18:30:00.000Z');
  const out = await b.candles({ exchange: 'NFO', token: '35001', symbol: 'X' }, 'ONE_MINUTE', from, to);
  expect(manager.fetchCandleWindow).toHaveBeenCalledWith('owner', { token: '35001', exchange: 'NFO' }, 'ONE_MINUTE', from, to);
  expect(out).toEqual([{ ts: Date.parse('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }]);
});
