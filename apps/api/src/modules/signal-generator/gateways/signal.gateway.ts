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
import { isAdminSocket } from '../../../common/ws/authenticate-admin-socket';

// IMPORTANT: this gateway MUST NOT share the public '/ws' namespace with
// MarketDataGateway. It admin-gates its handshake and disconnects non-admin
// sockets (isAdminSocket → client.disconnect()); on a shared namespace that
// disconnect also kills the public tick feed for every browser (they connect to
// '/ws' with no admin token). So it lives on its own sub-namespace, like the
// trades ('/ws/trades') and auto-trade ('/ws/auto-trade') gateways.
@WebSocketGateway({
  namespace: `${WS_NAMESPACE}/signals`,
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
    if (!isAdminSocket(client)) {
      // `disconnect()` NOT `disconnect(true)` — close=true would tear down the
      // shared engine.io transport and every other namespace on it.
      client.disconnect();
      return;
    }
    this.logger.debug(`Signal ADMIN socket connected: ${client.id}`);
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
