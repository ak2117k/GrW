import {
  WebSocketGateway, WebSocketServer, OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

@WebSocketGateway({ cors: { origin: CORS_ORIGIN, credentials: true }, namespace: '/watch' })
export class WatchGateway implements OnGatewayInit {
  private readonly logger = new Logger(WatchGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.logger.log(`WatchGateway initialized (namespace=/watch origin=${CORS_ORIGIN})`);
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
