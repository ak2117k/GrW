import * as jwt from 'jsonwebtoken';
import { MarketDataGateway } from './market-data.gateway';
import type { UserFeedManager } from '../services/user-feed-manager.service';

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

function fakeSocket(token?: string) {
  const rooms: string[] = [];
  return {
    id: 's1',
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
    gw.handleUnsubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
    expect(manager.unsubscribe).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
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
});
