import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { WS_NAMESPACE } from '@td/shared/constants';
import { ACCESS_TOKEN_AUDIENCE } from '../../auth/services/token.service';

@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: { origin: '*' },
})
export class SignalGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(SignalGateway.name);

  @WebSocketServer()
  private server: Server;

  afterInit(): void {
    this.logger.log('SignalGateway initialized');
  }

  handleConnection(client: Socket): void {
    const raw =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
    try {
      const payload = jwt.verify(raw ?? '', process.env.JWT_SECRET as string, {
        algorithms: ['HS256'],
        audience: ACCESS_TOKEN_AUDIENCE,
      }) as { role?: string; sub?: string };
      if (payload.role !== 'ADMIN') {
        client.disconnect(true);
        return;
      }
      this.logger.debug(`Signal ADMIN socket connected: ${client.id}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Signal client disconnected: ${client.id}`);
  }

  /**
   * Broadcast a new signal to all connected clients.
   */
  emitNewSignal(signal: any): void {
    this.server.emit('new-signal', signal);
    this.logger.debug(
      `Emitted new-signal: ${signal.instrument?.symbol ?? signal.id}`,
    );
  }

  /**
   * Notify all connected clients that a signal has been deactivated.
   */
  emitSignalExpired(signalId: string): void {
    this.server.emit('signal-expired', { signalId });
    this.logger.debug(`Emitted signal-expired: ${signalId}`);
  }
}
