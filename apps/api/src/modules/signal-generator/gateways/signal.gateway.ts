import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WS_NAMESPACE } from '@td/shared/constants';

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
    this.logger.debug(`Signal client connected: ${client.id}`);
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
