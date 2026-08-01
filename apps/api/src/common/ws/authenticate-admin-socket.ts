import type { Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_AUDIENCE } from '../../modules/auth/services/token.service';

/**
 * Shared handshake authenticator for ADMIN-only WebSocket gateways.
 *
 * Provenance-bearing gateways (signal, watch, adaptive-stop, ungated) broadcast
 * raw IP rows via `server.emit(...)`, so a non-ADMIN socket must never be allowed
 * to stay connected. This centralises the verify-and-check used by every such
 * gateway: read the JWT from `handshake.auth.token` (preferred) else the
 * `Authorization: Bearer` header, verify it as an HS256 access token, and require
 * `role === 'ADMIN'`. Fails closed: any missing/invalid token or non-ADMIN role
 * returns false.
 */
export function isAdminSocket(client: Socket): boolean {
  const raw =
    (client.handshake.auth?.token as string | undefined) ??
    client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify(raw ?? '', process.env.JWT_SECRET as string, {
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    }) as { role?: string };
    return payload.role === 'ADMIN';
  } catch {
    return false;
  }
}

/**
 * Disconnect the socket unless it carries a valid ADMIN access token.
 * Returns true if the socket was accepted (ADMIN), false if it was disconnected.
 *
 * MUST use `disconnect()` (close=false), never `disconnect(true)`: socket.io
 * multiplexes every namespace a browser opens over ONE engine.io transport, and
 * close=true runs `client._disconnect()` — disconnecting EVERY namespace on that
 * transport and closing it. A non-admin hitting an admin namespace would then
 * lose their `/ws` tick feed, `/ws/trades` and `/ws/auto-trade` as collateral.
 * close=false sends a DISCONNECT packet for THIS namespace only.
 */
export function requireAdminSocket(client: Socket): boolean {
  if (isAdminSocket(client)) return true;
  client.disconnect();
  return false;
}
