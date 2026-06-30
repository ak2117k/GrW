import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import { WS_NAMESPACE } from '@td/shared/constants';
import { SignalGateway } from '../../src/modules/signal-generator/gateways/signal.gateway';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda006';
const jwt = new JwtService();
const tok = (role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub: `u-${role}`, role, email: `${role}@t.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

// The gateway authenticates inside `handleConnection`, which runs *after*
// socket.io has already acknowledged the namespace join — so a rejected client
// first sees `connect`, then immediately `disconnect` ("io server disconnect").
// Resolving on the first `connect` would therefore report a false positive, so
// we settle on the terminal state: `connect_error`/`disconnect` => rejected,
// and a bounded timeout reads `sock.connected` for the accept path.
function connect(url: string, token?: string): Promise<{ ok: boolean; sock: Socket }> {
  return new Promise((resolve) => {
    const sock = io(`${url}${WS_NAMESPACE}`, {
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

let app: INestApplication;
let url: string;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ providers: [SignalGateway] }).compile();
  app = mod.createNestApplication();
  await app.init();
  await app.listen(0);
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
});

it('rejects a socket with no token', async () => expect((await connect(url)).ok).toBe(false));
it('rejects a USER socket', async () => expect((await connect(url, tok('USER'))).ok).toBe(false));
it('accepts an ADMIN socket', async () => {
  const r = await connect(url, tok('ADMIN'));
  expect(r.ok).toBe(true);
  r.sock.close();
});
