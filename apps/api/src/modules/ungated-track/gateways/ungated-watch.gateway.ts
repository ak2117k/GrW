import {
  WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { isAdminSocket } from '../../../common/ws/authenticate-admin-socket';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/**
 * MIRROR OF watch.gateway.ts on a separate namespace so the frontend can
 * subscribe to ungated tick/entry updates independently of the gated
 * track. See specs/2026-05-20-ungated-shadow-track-design.md.
 */
@WebSocketGateway({
  cors: { origin: CORS_ORIGIN, credentials: true },
  namespace: '/ungated-watch',
})
export class UngatedWatchGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(UngatedWatchGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.logger.log(
      `UngatedWatchGateway initialized (namespace=/ungated-watch origin=${CORS_ORIGIN})`,
    );
  }

  // ungated:entry carries raw provenance. Reject non-ADMIN sockets.
  handleConnection(client: Socket) {
    if (!isAdminSocket(client)) {
      // `disconnect()` NOT `disconnect(true)` — close=true would tear down the
      // shared engine.io transport and every other namespace on it.
      client.disconnect();
    }
  }

  /** Full updated row — frontend merges in place, no refetch. */
  emitEntry(entry: unknown) {
    this.server.emit('ungated:entry', entry);
  }
}
