import type { Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_AUDIENCE } from '../../modules/auth/services/token.service';

/**
 * Handshake authenticator for PER-USER WebSocket gateways.
 *
 * Mirrors `authenticate-admin-socket.ts` but instead of asserting an ADMIN role
 * it identifies WHICH user the socket belongs to: read the JWT from
 * `handshake.auth.token` (preferred) else the `Authorization: Bearer` header,
 * verify it as an HS256 access token, and return its subject (`sub`). This id is
 * used to join the socket to its own `user:{id}` room so live ticks/candles are
 * routed only to that user. Fails closed: any missing/invalid token returns null.
 */
export function getUserIdFromSocket(client: Socket): string | null {
  const raw =
    (client.handshake.auth?.token as string | undefined) ??
    client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
  try {
    const payload = jwt.verify(raw ?? '', process.env.JWT_SECRET as string, {
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    }) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
