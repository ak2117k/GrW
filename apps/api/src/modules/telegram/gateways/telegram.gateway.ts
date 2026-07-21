import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { isAdminSocket } from '../../../common/ws/authenticate-admin-socket';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/**
 * ADMIN-only gateway for the Telegram signal scorecard (namespace `/ws/telegram`).
 * Broadcasts outcome transitions (signal-update) so the admin UI merges rows in
 * place without a refetch. signal-update carries raw provenance (channel result),
 * so a non-ADMIN socket is disconnected on connect (fail closed).
 */
@WebSocketGateway({
  cors: { origin: CORS_ORIGIN, credentials: true },
  namespace: '/ws/telegram',
})
export class TelegramGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(TelegramGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.logger.log(
      `TelegramGateway initialized (namespace=/ws/telegram origin=${CORS_ORIGIN})`,
    );
  }

  handleConnection(client: Socket) {
    if (!isAdminSocket(client)) {
      client.disconnect(true);
    }
  }

  emit(event: string, payload: unknown) {
    this.server?.emit(`telegram:${event}`, payload);
  }
}
