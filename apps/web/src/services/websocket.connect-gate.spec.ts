import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY } from './auth-storage';

/**
 * `wsService.connect()` must not open sockets before there is an access token.
 *
 * The `/ws` gateway rejects a socket whose handshake JWT is missing and, per
 * socket.io, an "io server disconnect" is TERMINAL — the client never retries on
 * its own. Our manual retry is token-gated (correctly: a logged-out user must
 * not hot-loop), so a connect() that runs pre-login is rejected at a moment when
 * no token exists, schedules no retry, and the tick feed stays dead for the rest
 * of the session even after the user signs in. Gating connect() on a stored
 * token keeps `sockets` empty so the post-login connect() actually opens them.
 */

const sockets: FakeSocket[] = [];

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connected: boolean;
  io: { engine: { transport: { name: string }; on: ReturnType<typeof vi.fn> } };
}

function makeFakeSocket(): FakeSocket {
  return {
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    io: { engine: { transport: { name: 'websocket' }, on: vi.fn() } },
  };
}

const ioMock = vi.fn(() => {
  const s = makeFakeSocket();
  sockets.push(s);
  return s;
});

vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioMock(...(args as [])) }));

/** Minimal localStorage + window so the service can run under the node env. */
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

describe('wsService.connect() token gate', () => {
  let wsService: typeof import('./websocket').wsService;

  beforeEach(async () => {
    sockets.length = 0;
    ioMock.mockClear();
    installBrowserGlobals();
    vi.useFakeTimers();
    // Fresh module per test — the service is a singleton holding socket state.
    vi.resetModules();
    ({ wsService } = await import('./websocket'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens no sockets when there is no access token', () => {
    wsService.connect();
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('opens every namespace once an access token is stored', () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'jwt-abc');
    wsService.connect();
    expect(ioMock).toHaveBeenCalledTimes(4);
  });

  it('still connects on a later call after a pre-login no-op connect', () => {
    // Boot at the login screen: no token yet.
    wsService.connect();
    expect(ioMock).not.toHaveBeenCalled();

    // User signs in; the app calls connect() again.
    localStorage.setItem(ACCESS_TOKEN_KEY, 'jwt-abc');
    wsService.connect();
    expect(ioMock).toHaveBeenCalledTimes(4);
  });

  it('re-opens sockets after a disconnect (logout then login again)', () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'jwt-abc');
    wsService.connect();
    expect(ioMock).toHaveBeenCalledTimes(4);

    wsService.disconnect();
    ioMock.mockClear();

    wsService.connect();
    expect(ioMock).toHaveBeenCalledTimes(4);
  });
});
