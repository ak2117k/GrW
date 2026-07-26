import * as jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { getUserIdFromSocket } from './authenticate-user-socket';

const SECRET = 'test-secret-user-socket';
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

/** Build a minimal fake handshake-bearing Socket. */
function fakeSocket(opts: {
  authToken?: string;
  authHeader?: string;
}): Socket {
  return {
    handshake: {
      auth: opts.authToken ? { token: opts.authToken } : {},
      headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    },
  } as unknown as Socket;
}

function sign(
  payload: Record<string, unknown>,
  audience = 'td-access',
): string {
  return jwt.sign(payload, SECRET, {
    algorithm: 'HS256',
    audience,
    expiresIn: '5m',
  });
}

describe('getUserIdFromSocket', () => {
  it('returns the sub for a valid access token in handshake.auth.token', () => {
    const token = sign({ sub: 'u1', role: 'USER' });
    expect(getUserIdFromSocket(fakeSocket({ authToken: token }))).toBe('u1');
  });

  it('reads the token from the Authorization: Bearer header', () => {
    const token = sign({ sub: 'u2' });
    expect(
      getUserIdFromSocket(fakeSocket({ authHeader: `Bearer ${token}` })),
    ).toBe('u2');
  });

  it('returns null when no token is present', () => {
    expect(getUserIdFromSocket(fakeSocket({}))).toBeNull();
  });

  it('returns null for a token with the wrong audience', () => {
    const token = sign({ sub: 'u3' }, 'wrong-audience');
    expect(getUserIdFromSocket(fakeSocket({ authToken: token }))).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    const bad = jwt.sign({ sub: 'u4' }, 'some-other-secret', {
      algorithm: 'HS256',
      audience: 'td-access',
      expiresIn: '5m',
    });
    expect(getUserIdFromSocket(fakeSocket({ authToken: bad }))).toBeNull();
  });
});
