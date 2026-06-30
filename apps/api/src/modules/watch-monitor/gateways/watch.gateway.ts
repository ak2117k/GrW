import {
  WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { isAdminSocket } from '../../../common/ws/authenticate-admin-socket';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

@WebSocketGateway({ cors: { origin: CORS_ORIGIN, credentials: true }, namespace: '/watch' })
export class WatchGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(WatchGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.logger.log(`WatchGateway initialized (namespace=/watch origin=${CORS_ORIGIN})`);
  }

  // watch:* events carry raw provenance (scannerName, initial/currentBreakdown,
  // trailing fields). Reject any socket without a valid ADMIN access token.
  handleConnection(client: Socket) {
    if (!isAdminSocket(client)) {
      client.disconnect(true);
    }
  }

  emitTick(entryId: string, payload: { price: number; currentScore: number | null }) {
    this.server.emit('watch:tick', { entryId, ...payload });
  }

  emitEvent(entryId: string, eventType: string, payload: Record<string, unknown>) {
    this.server.emit('watch:event', { entryId, eventType, ...payload });
  }

  emitCreated(entry: unknown) {
    this.server.emit('watch:created', entry);
  }

  /**
   * Push the full updated entry row so the frontend merges in place.
   * Replaces the older "tick → refetch entire list" hop that caused
   * the watch table to flash on every tick.
   */
  emitEntry(entry: unknown) {
    this.server.emit('watch:entry', entry);
  }
}
