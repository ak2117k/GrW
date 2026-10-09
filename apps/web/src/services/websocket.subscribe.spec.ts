import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY } from './auth-storage';

/** Same fake-socket harness as websocket.connect-gate.spec.ts. */
interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connected: boolean;
  io: { engine: { transport: { name: string }; on: ReturnType<typeof vi.fn> } };
}

const sockets: FakeSocket[] = [];
const ioMock = vi.fn(() => {
  const s: FakeSocket = {
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    io: { engine: { transport: { name: 'websocket' }, on: vi.fn() } },
  };
  sockets.push(s);
  return s;
});
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioMock(...(args as [])) }));

function installBrowserGlobals(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal('window', {});
}

/** Fire a handler the service registered on a fake socket with `sock.on(event, fn)`. */
function fire(sock: FakeSocket, event: string, payload?: unknown): void {
  const call = sock.on.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`no ${event} handler`);
  (call[1] as (p?: unknown) => void)(payload);
}

describe('wsService subscriptions', () => {
  let wsService: typeof import('./websocket').wsService;

  beforeEach(async () => {
    sockets.length = 0;
    ioMock.mockClear();
    installBrowserGlobals();
    localStorage.setItem(ACCESS_TOKEN_KEY, 'jwt');
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.resetModules();
    ({ wsService } = await import('./websocket'));
  });

  afterEach(() => {
    wsService.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ref-counts subscriptions: one emit per new ref, one unsubscribe when the last holder releases', () => {
    wsService.connect();
    const ws = sockets[0]; // '/ws' is the first namespace
    wsService.emitSubscribe([{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }], 'chart');
    wsService.emitSubscribe([{ token: '35001', exchange: 'NFO' }], 'watchlist'); // a second holder: no emit
    expect(ws.emit.mock.calls).toEqual([
      ['subscribe', { tokens: ['35001'], refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }], purpose: 'chart' }],
    ]);
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]);
    expect(ws.emit).toHaveBeenCalledTimes(1); // still held by the other hook
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]);
    expect(ws.emit).toHaveBeenLastCalledWith('unsubscribe', {
      tokens: ['35001'],
      refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }],
    });
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]); // over-release is a no-op
    expect(ws.emit).toHaveBeenCalledTimes(2);
  });

  it('the same token on two exchanges is two subscriptions', () => {
    wsService.connect();
    const ws = sockets[0];
    wsService.emitSubscribe([{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }], 'watchlist');
    expect(ws.emit).toHaveBeenCalledWith('subscribe', {
      tokens: ['1594', '1594'],
      refs: [{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }],
      purpose: 'watchlist',
    });
  });

  it('replays every subscription, grouped by purpose, when /ws reconnects', () => {
    wsService.emitSubscribe([{ token: '2885', exchange: 'NSE' }], 'watchlist'); // before connect: remembered
    wsService.emitSubscribe([{ token: '35001', exchange: 'NFO' }], 'chart');
    wsService.connect();
    const ws = sockets[0];
    fire(ws, 'connect');
    expect(ws.emit.mock.calls).toEqual([
      ['subscribe', { tokens: ['2885'], refs: [{ token: '2885', exchange: 'NSE' }], purpose: 'watchlist' }],
      ['subscribe', { tokens: ['35001'], refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' }],
    ]);
  });

  it('remembers the server’s feed-source and forwards it to subscribers; junk is ignored', () => {
    wsService.connect();
    const ws = sockets[0];
    const seen: unknown[] = [];
    wsService.subscribe('feed-source', (d) => seen.push(d));
    expect(wsService.getFeedSource()).toBeNull();
    fire(ws, 'feed-source', { source: 'hub' });
    expect(wsService.getFeedSource()).toBe('hub');
    fire(ws, 'feed-source', { source: 'bogus' });
    expect(wsService.getFeedSource()).toBe('hub');
    expect(seen).toEqual([{ source: 'hub' }, { source: 'bogus' }]);
  });
});
