import {
  WebSocketGateway, WebSocketServer, OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/**
 * MIRROR OF watch.gateway.ts on a separate namespace so the frontend can
 * subscribe to adaptive-stop tick/entry updates independently of the gated
 * and ungated tracks. See specs/2026-06-09-adaptive-stop-track-design.md.
 */
@WebSocketGateway({
  cors: { origin: CORS_ORIGIN, credentials: true },
  namespace: '/adaptive-stop-watch',
})
export class AdaptiveStopGateway implements OnGatewayInit {
  private readonly logger = new Logger(AdaptiveStopGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.logger.log(
      `AdaptiveStopGateway initialized (namespace=/adaptive-stop-watch origin=${CORS_ORIGIN})`,
    );
  }

  /** Full updated row — frontend merges in place, no refetch. */
  emitEntry(entry: unknown) {
    this.server.emit('adaptive-stop:entry', entry);
  }
}
