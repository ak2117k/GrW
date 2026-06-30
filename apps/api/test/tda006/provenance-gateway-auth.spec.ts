/**
 * TDA-006 fix #2 — the three provenance WS gateways (watch /watch,
 * adaptive-stop /adaptive-stop-watch, ungated /ungated-watch) broadcast raw
 * provenance rows, so each must reject a non-ADMIN / no-token socket on connect.
 *
 * Two layers:
 *   1. Unit  — the shared `isAdminSocket` helper (used by all four gateways).
 *   2. Integration — boot the three gateways and assert a real socket.io client
 *      with no token / a USER token is disconnected, and an ADMIN token stays.
 *
 * Run from apps/api:
 *   npx jest --config test/tda006/jest.config.js provenance-gateway-auth --verbose
 */

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda006';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import type { Socket as ServerSocket } from 'socket.io';
import { isAdminSocket } from '../../src/common/ws/authenticate-admin-socket';
import { WatchGateway } from '../../src/modules/watch-monitor/gateways/watch.gateway';
import { AdaptiveStopGateway } from '../../src/modules/adaptive-stop-track/gateways/adaptive-stop.gateway';
import { UngatedWatchGateway } from '../../src/modules/ungated-track/gateways/ungated-watch.gateway';

const jwt = new JwtService();
const tok = (role: 'USER' | 'ADMIN', opts: { audience?: string } = {}) =>
  jwt.sign(
    { sub: `u-${role}`, role, email: `${role}@t.local` },
    {
      secret: process.env.JWT_SECRET,
      algorithm: 'HS256',
      audience: opts.audience ?? 'td-access',
      expiresIn: '15m',
    },
  );

/** Build a minimal Socket-shaped object the helper reads from. */
const fakeClient = (token?: string, header?: string): ServerSocket =>
  ({
    handshake: {
      auth: token ? { token } : {},
      headers: header ? { authorization: header } : {},
    },
  } as unknown as ServerSocket);

describe('TDA-006 fix #2 — isAdminSocket helper (fail-closed)', () => {
  it('rejects a socket with no token', () => {
    expect(isAdminSocket(fakeClient())).toBe(false);
  });
  it('rejects a USER token in handshake.auth', () => {
    expect(isAdminSocket(fakeClient(tok('USER')))).toBe(false);
  });
  it('rejects a malformed/garbage token', () => {
    expect(isAdminSocket(fakeClient('not-a-jwt'))).toBe(false);
  });
  it('rejects an ADMIN token minted for the wrong audience', () => {
    expect(isAdminSocket(fakeClient(tok('ADMIN', { audience: 'td-refresh' })))).toBe(false);
  });
  it('accepts an ADMIN token in handshake.auth', () => {
    expect(isAdminSocket(fakeClient(tok('ADMIN')))).toBe(true);
  });
  it('accepts an ADMIN token via the Authorization header', () => {
    expect(isAdminSocket(fakeClient(undefined, `Bearer ${tok('ADMIN')}`))).toBe(true);
  });
});

// The gateway authenticates inside handleConnection, which runs AFTER socket.io
// has acknowledged the namespace join — a rejected client first sees `connect`,
// then immediately `disconnect`. We settle on the terminal state: a
// connect_error/disconnect => rejected; a bounded timeout reads sock.connected
// for the accept path. (Same approach as signal-gateway-auth.spec.ts.)
function connect(url: string, namespace: string, token?: string): Promise<{ ok: boolean; sock: Socket }> {
  return new Promise((resolve) => {
    const sock = io(`${url}${namespace}`, {
      transports: ['websocket'],
      forceNew: true,
      auth: token ? { token } : {},
      reconnection: false,
    });
    sock.on('connect_error', () => resolve({ ok: false, sock }));
    sock.on('disconnect', () => resolve({ ok: false, sock }));
    setTimeout(() => resolve({ ok: sock.connected, sock }), 1200);
  });
}

describe('TDA-006 fix #2 — provenance gateways reject non-ADMIN sockets', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [WatchGateway, AdaptiveStopGateway, UngatedWatchGateway],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const NAMESPACES: Array<[string, string]> = [
    ['WatchGateway', '/watch'],
    ['AdaptiveStopGateway', '/adaptive-stop-watch'],
    ['UngatedWatchGateway', '/ungated-watch'],
  ];

  describe.each(NAMESPACES)('%s (namespace %s)', (_name, ns) => {
    it('rejects a socket with no token', async () => {
      const { ok, sock } = await connect(url, ns);
      sock.close();
      expect(ok).toBe(false);
    });
    it('rejects a USER socket', async () => {
      const { ok, sock } = await connect(url, ns, tok('USER'));
      sock.close();
      expect(ok).toBe(false);
    });
    it('accepts an ADMIN socket', async () => {
      const { ok, sock } = await connect(url, ns, tok('ADMIN'));
      sock.close();
      expect(ok).toBe(true);
    });
  });
});
