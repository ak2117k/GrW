import * as jwt from 'jsonwebtoken';
import { MarketDataGateway } from './market-data.gateway';
import type { UserFeedManager } from '../services/user-feed-manager.service';
import type { Price } from '../../market-hub/hub.types';

const SECRET = 'test-secret';
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

function signToken(sub: string): string {
  return jwt.sign({ sub, role: 'USER', email: 'u@x.com' }, SECRET, {
    algorithm: 'HS256',
    audience: 'td-access',
    expiresIn: '5m',
  });
}

function fakeSocket(token?: string, id = 's1') {
  const rooms: string[] = [];
  return {
    id,
    handshake: { auth: token ? { token } : {}, headers: {} },
    data: {} as any,
    join: (r: string) => rooms.push(r),
    leave: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
    __rooms: rooms,
  };
}

function fakeManager() {
  return {
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    releaseUser: jest.fn(),
    setHandlers: jest.fn(),
  } as unknown as jest.Mocked<UserFeedManager>;
}

function makeGateway(manager = fakeManager()): {
  gw: MarketDataGateway;
  manager: jest.Mocked<UserFeedManager>;
} {
  const gw = new MarketDataGateway(manager);
  return { gw, manager };
}

/** A hub that hands its price listener back to the test. */
function fakeHub() {
  const listeners = new Set<(p: Price) => void>();
  const hub = {
    price: jest.fn(),
    prices: jest.fn(),
    watch: jest.fn().mockResolvedValue(undefined),
    unwatch: jest.fn().mockResolvedValue(undefined),
    onPrice: jest.fn((fn: (p: Price) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }),
  };
  return { hub, listeners, push: (p: Price) => listeners.forEach((fn) => fn(p)) };
}

/** A gateway whose ModuleRef resolves a HubPriceSource serving `serves` (the owner) for 'browser' only. */
function hubGateway(serves: string[] = ['owner']) {
  const { hub, listeners, push } = fakeHub();
  const source = {
    hubFor: jest.fn((userId: string | null, consumer: string) =>
      consumer === 'browser' && userId !== null && serves.includes(userId) ? hub : null,
    ),
    record: jest.fn(),
  };
  const moduleRef = { get: jest.fn(() => source) };
  const manager = fakeManager();
  const gw = new MarketDataGateway(manager, moduleRef as any);
  const emitsByRoom: Record<string, Array<{ event: string; payload: any }>> = {};
  (gw as any).server = {
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => {
        (emitsByRoom[room] ??= []).push({ event, payload });
      },
    })),
  };
  return { gw, manager, hub, listeners, push, source, emitsByRoom };
}

const OPT = (ltp: number, exchange: Price['ref']['exchange'] = 'NFO'): Price => ({
  ref: { exchange, token: '35001', symbol: 'NIFTY26OCT25000CE' },
  ltp,
  at: 1_760_000_000_000,
  source: 'ws',
  day: { open: 100, high: 125, low: 95, close: 110 },
});

describe('MarketDataGateway', () => {
  it('rejects an unauthenticated socket', () => {
    const { gw } = makeGateway();
    const sock = fakeSocket(undefined);
    gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalled();
    expect(sock.data.userId).toBeUndefined();
  });

  it('authenticated socket joins its user room', () => {
    const { gw } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    expect(sock.data.userId).toBe('u1');
    expect(sock.__rooms).toContain('user:u1');
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('handleSubscribe routes tokens to the manager for the socket user', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    const ack = gw.handleSubscribe(sock as any, { tokens: ['111', '222'] });
    expect(manager.subscribe).toHaveBeenCalledWith('u1', [
      { token: '111', exchange: 'NSE' },
      { token: '222', exchange: 'NSE' },
    ]);
    expect(ack).toEqual({ event: 'subscribed', data: { subscribed: ['111', '222'] } });
  });

  it('handleSubscribe skips the manager when the socket has no user', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(undefined);
    // no handleConnection -> no userId on data
    gw.handleSubscribe(sock as any, { tokens: ['111'] });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it('handleUnsubscribe routes tokens to the manager', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { tokens: ['111'] }); // only a held ref is released
    gw.handleUnsubscribe(sock as any, { tokens: ['111'] });
    expect(manager.unsubscribe).toHaveBeenCalledWith('u1', [
      { token: '111', exchange: 'NSE' },
    ]);
  });

  it('handleDisconnect releases the user', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleDisconnect(sock as any);
    expect(manager.releaseUser).toHaveBeenCalledWith('u1');
  });

  it('afterInit registers manager handlers', () => {
    const { gw, manager } = makeGateway();
    (gw as any).server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    gw.afterInit();
    expect(manager.setHandlers).toHaveBeenCalledTimes(1);
    gw.onModuleDestroy();
  });

  it('emitTickToUser targets only that user room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const { gw } = makeGateway();
    (gw as any).server = { to };
    gw.emitTickToUser('u1', { token: '1' } as any);
    gw.flushForTest();
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('tick', { token: '1' });
  });

  it('emitTickToUser does not cross user boundaries', () => {
    const emitsByRoom: Record<string, unknown[]> = {};
    const to = jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => {
        (emitsByRoom[room] ??= []).push({ event, payload });
      },
    }));
    const { gw } = makeGateway();
    (gw as any).server = { to };
    gw.emitTickToUser('u1', { token: '1' } as any);
    gw.emitTickToUser('u2', { token: '2' } as any);
    gw.flushForTest();
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(to).toHaveBeenCalledWith('user:u2');
    expect(emitsByRoom['user:u1']).toEqual([{ event: 'tick', payload: { token: '1' } }]);
    expect(emitsByRoom['user:u2']).toEqual([{ event: 'tick', payload: { token: '2' } }]);
  });

  it('emitCandleToUser targets only that user room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const { gw } = makeGateway();
    (gw as any).server = { to };
    gw.emitCandleToUser('u1', { token: '1' } as any);
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('candle', { token: '1' });
  });

  it('subscribe uses the exchange the client sends, so an NFO option is not subscribed as NSE', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    const ack = gw.handleSubscribe(sock as any, {
      refs: [
        { token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' },
        { token: '2885', exchange: 'nse' },
      ],
    });
    expect(manager.subscribe).toHaveBeenCalledWith('u1', [
      { token: '35001', exchange: 'NFO' },
      { token: '2885', exchange: 'NSE' },
    ]);
    expect(ack).toEqual({ event: 'subscribed', data: { subscribed: ['35001', '2885'] } });
  });

  it('accepts EXCHANGE:token strings and drops unknown exchanges and junk tokens', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { tokens: ['MCX:4321', 'CDS:1', 'abc', '0'] });
    expect(manager.subscribe).toHaveBeenCalledWith('u1', [{ token: '4321', exchange: 'MCX' }]);
  });

  it('does not call the manager when nothing valid was sent', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'XYZ' }] });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribe uses the same exchange-aware refs', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }] }); // only a held ref is released
    gw.handleUnsubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
    expect(manager.unsubscribe).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
  });

  describe('legacy path: per-socket dedupe so the manager ref-count stays balanced', () => {
    it('the same ref subscribed twice (chart then watchlist) reaches the manager once; one unsubscribe releases it once', () => {
      const { gw, manager } = makeGateway();
      const sock = fakeSocket(signToken('u1'));
      gw.handleConnection(sock as any);
      const ref = { token: '35001', exchange: 'NFO' };
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'chart' });
      const ack = gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'watchlist' });
      expect(manager.subscribe).toHaveBeenCalledTimes(1);
      expect(manager.subscribe).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
      expect(ack).toEqual({ event: 'subscribed', data: { subscribed: ['35001'] } }); // ack unchanged
      gw.handleUnsubscribe(sock as any, { refs: [ref] });
      expect(manager.unsubscribe).toHaveBeenCalledTimes(1);
      expect(manager.unsubscribe).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
      gw.handleUnsubscribe(sock as any, { refs: [ref] }); // no longer held
      expect(manager.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('forwards only the new refs of a mixed subscribe', () => {
      const { gw, manager } = makeGateway();
      const sock = fakeSocket(signToken('u1'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'NSE' }] });
      gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'NSE' }, { token: '1', exchange: 'MCX' }] });
      expect(manager.subscribe).toHaveBeenLastCalledWith('u1', [{ token: '1', exchange: 'MCX' }]);
    });

    it('unsubscribing a ref the socket never subscribed does not call the manager', () => {
      const { gw, manager } = makeGateway();
      const sock = fakeSocket(signToken('u1'));
      gw.handleConnection(sock as any);
      gw.handleUnsubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
      expect(manager.unsubscribe).not.toHaveBeenCalled();
    });

    it('two legacy sockets of one user each forward their own subscribe and unsubscribe (multi-tab stays balanced)', () => {
      const { gw, manager } = makeGateway();
      const a = fakeSocket(signToken('u1'), 'a');
      const b = fakeSocket(signToken('u1'), 'b');
      gw.handleConnection(a as any);
      gw.handleConnection(b as any);
      const ref = { token: '35001', exchange: 'NFO' };
      gw.handleSubscribe(a as any, { refs: [ref] });
      gw.handleSubscribe(b as any, { refs: [ref] });
      expect(manager.subscribe).toHaveBeenCalledTimes(2);
      gw.handleUnsubscribe(a as any, { refs: [ref] });
      gw.handleUnsubscribe(b as any, { refs: [ref] });
      expect(manager.unsubscribe).toHaveBeenCalledTimes(2);
    });

    it('a disconnect forgets the socket’s refs: a reconnecting socket with the same id forwards again', () => {
      const { gw, manager } = makeGateway();
      const sock = fakeSocket(signToken('u1'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'NSE' }] });
      gw.handleDisconnect(sock as any);
      expect(manager.releaseUser).toHaveBeenCalledWith('u1');
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'NSE' }] });
      expect(manager.subscribe).toHaveBeenCalledTimes(2);
    });

    it('a legacy socket forwards at most 100 refs', () => {
      const { gw, manager } = makeGateway();
      const sock = fakeSocket(signToken('u1'));
      gw.handleConnection(sock as any);
      const refs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ token: String(from + i), exchange: 'NSE' }));
      gw.handleSubscribe(sock as any, { refs: refs(1, 90) });
      gw.handleSubscribe(sock as any, { refs: refs(1001, 30) });
      const forwarded = manager.subscribe.mock.calls.reduce((n, c) => n + (c[1] as unknown[]).length, 0);
      expect(forwarded).toBe(100);
    });
  });

  it('coalesces per EXCHANGE:token: the same token on two exchanges is two ticks', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const { gw } = makeGateway();
    (gw as any).server = { to };
    gw.emitTickToUser('u1', { token: '1594', exchange: 'NSE', ltp: 1 } as any);
    gw.emitTickToUser('u1', { token: '1594', exchange: 'MCX', ltp: 2 } as any);
    gw.emitTickToUser('u1', { token: '1594', exchange: 'NSE', ltp: 3 } as any); // newest NSE wins
    gw.flushForTest();
    expect(emit.mock.calls).toEqual([
      ['tick', { token: '1594', exchange: 'NSE', ltp: 3 }],
      ['tick', { token: '1594', exchange: 'MCX', ltp: 2 }],
    ]);
  });

  describe('hub path (HUB_SERVES_BROWSER)', () => {
    it('tells each browser which path serves it: hub for the owner, legacy for everyone else', () => {
      const { gw } = hubGateway();
      const owner = fakeSocket(signToken('owner'), 's-owner');
      const other = fakeSocket(signToken('u2'), 's-other');
      gw.handleConnection(owner as any);
      gw.handleConnection(other as any);
      expect(owner.emit).toHaveBeenCalledWith('feed-source', { source: 'hub' });
      expect(other.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });
    });

    it('owner: subscribe watches on the hub at the purpose priority, per socket, with the screen TTL — never the manager', () => {
      const { gw, hub, manager } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], purpose: 'watchlist' });
      gw.handleSubscribe(sock as any, { refs: [{ token: '99926000', exchange: 'NSE', symbol: 'NIFTY' }], purpose: 'context' });
      expect(hub.watch.mock.calls).toEqual([
        [[{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }], 4, 'browser:s1', 120_000],
        [[{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 3, 'browser:s1', 120_000],
        [[{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }], 2, 'browser:s1', 120_000],
      ]);
      expect(manager.subscribe).not.toHaveBeenCalled();
    });

    it('owner: a repeat subscribe is a no-op unless it raises the priority', () => {
      const { gw, hub } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      const ref = { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' };
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'watchlist' });
      expect(hub.watch.mock.calls.map((c) => c[1])).toEqual([4, 3]);
    });

    it('pushes every hub price to the owner room only, coalesced per EXCHANGE:token, as a Quote-compatible tick', () => {
      const { gw, push, emitsByRoom } = hubGateway();
      gw.handleConnection(fakeSocket(signToken('owner'), 's-owner') as any);
      gw.handleConnection(fakeSocket(signToken('u2'), 's-other') as any);
      push(OPT(120));
      push(OPT(121)); // newest wins within the 100 ms window
      push({ ...OPT(5, 'MCX'), ref: { exchange: 'MCX', token: '35001', symbol: 'CRUDEOIL' } }); // same token, other exchange
      gw.flushForTest();
      const ticks = emitsByRoom['user:owner'].filter((e) => e.event === 'tick').map((e) => e.payload);
      expect(ticks).toHaveLength(2);
      expect(ticks[0]).toMatchObject({ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE', ltp: 121, close: 110, change: 11, source: 'ws' });
      expect(ticks[1]).toMatchObject({ token: '35001', exchange: 'MCX', ltp: 5 });
      expect(emitsByRoom['user:u2']).toBeUndefined();
    });

    it('drops the legacy manager tick for a hub-served user (same session: it would be a duplicate)', () => {
      const { gw, emitsByRoom } = hubGateway();
      gw.handleConnection(fakeSocket(signToken('owner'), 's-owner') as any);
      gw.emitTickToUser('owner', { token: '35001', exchange: 'NFO', ltp: 1 } as any);
      gw.emitTickToUser('u2', { token: '2885', exchange: 'NSE', ltp: 2 } as any);
      gw.flushForTest();
      expect(emitsByRoom['user:owner']).toBeUndefined();
      expect(emitsByRoom['user:u2']).toEqual([{ event: 'tick', payload: { token: '2885', exchange: 'NSE', ltp: 2 } }]);
    });

    it('a non-owner never reads the owner hub: legacy feed-source, manager subscribe with the right exchange, legacy ticks', () => {
      const { gw, hub, manager, listeners, source } = hubGateway();
      const sock = fakeSocket(signToken('u2'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' });
      expect(source.hubFor).toHaveBeenCalledWith('u2', 'browser');
      expect(hub.watch).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      expect(manager.subscribe).toHaveBeenCalledWith('u2', [{ token: '35001', exchange: 'NFO' }]);
    });

    it('unsubscribe and disconnect unwatch that socket’s refs; the listener goes with the user’s last socket', () => {
      const { gw, hub, listeners, manager } = hubGateway();
      const a = fakeSocket(signToken('owner'), 'a');
      const b = fakeSocket(signToken('owner'), 'b');
      gw.handleConnection(a as any);
      gw.handleConnection(b as any);
      expect(hub.onPrice).toHaveBeenCalledTimes(1); // one listener per user, not per tab
      gw.handleSubscribe(a as any, { refs: [{ token: '35001', exchange: 'NFO' }, { token: '2885', exchange: 'NSE' }] });
      gw.handleUnsubscribe(a as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
      expect(hub.unwatch).toHaveBeenLastCalledWith([{ exchange: 'NFO', token: '35001', symbol: '35001' }], 'browser:a');
      gw.handleDisconnect(a as any);
      expect(hub.unwatch).toHaveBeenLastCalledWith([{ exchange: 'NSE', token: '2885', symbol: '2885' }], 'browser:a');
      expect(listeners.size).toBe(1);
      gw.handleDisconnect(b as any);
      expect(listeners.size).toBe(0);
      expect(manager.unsubscribe).not.toHaveBeenCalled();
    });

    it('a socket holds at most 100 hub watches', () => {
      const { gw, hub } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      const refs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ token: String(from + i), exchange: 'NSE' }));
      gw.handleSubscribe(sock as any, { refs: refs(1, 90) });
      gw.handleSubscribe(sock as any, { refs: refs(1001, 30) });
      const watched = hub.watch.mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);
      expect(watched).toBe(100);
    });

    it('renews every hub watch on the renew timer, grouped by priority', () => {
      jest.useFakeTimers();
      try {
        const { gw, hub } = hubGateway();
        gw.afterInit();
        const sock = fakeSocket(signToken('owner'));
        gw.handleConnection(sock as any);
        gw.handleSubscribe(sock as any, { refs: [{ token: '2885', exchange: 'NSE' }], purpose: 'watchlist' });
        gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' });
        hub.watch.mockClear();
        jest.advanceTimersByTime(60_000);
        expect(hub.watch.mock.calls).toEqual(
          expect.arrayContaining([
            [[{ exchange: 'NSE', token: '2885', symbol: '2885' }], 3, 'browser:s1', 120_000],
            [[{ exchange: 'NFO', token: '35001', symbol: '35001' }], 4, 'browser:s1', 120_000],
          ]),
        );
        gw.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('no hub in this container (lookup throws or no ModuleRef) is the legacy path', () => {
      const throwing = new MarketDataGateway(fakeManager(), { get: jest.fn(() => { throw new Error('no provider'); }) } as any);
      const s1 = fakeSocket(signToken('owner'));
      throwing.handleConnection(s1 as any);
      expect(s1.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });

      const { gw: plain, manager } = makeGateway();
      const s2 = fakeSocket(signToken('owner'));
      plain.handleConnection(s2 as any);
      expect(s2.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });
      plain.handleSubscribe(s2 as any, { refs: [{ token: '2885', exchange: 'NSE' }] });
      expect(manager.subscribe).toHaveBeenCalledWith('owner', [{ token: '2885', exchange: 'NSE' }]);
    });
  });
});
