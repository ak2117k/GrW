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

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

@WebSocketGateway({
  namespace: `${WS_NAMESPACE}/auto-trade`,
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
})
export class AutoTradeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AutoTradeGateway.name);

  @WebSocketServer()
  server: Server;

  private connectedClients = 0;

  afterInit(): void {
    this.logger.log('Auto-Trade WebSocket Gateway initialized');
  }

  handleConnection(_client: Socket): void {
    this.connectedClients++;
    this.logger.log(
      `Auto-Trade WS client connected (total: ${this.connectedClients})`,
    );
  }

  handleDisconnect(_client: Socket): void {
    this.connectedClients--;
    this.logger.log(
      `Auto-Trade WS client disconnected (total: ${this.connectedClients})`,
    );
  }

  /**
   * Emit pending approval event when a signal requires manual confirmation.
   */
  emitPendingApproval(data: Record<string, any>): void {
    this.server.emit('auto-trade:pending-approval', data);
  }

  /**
   * Emit signal approved event to all connected clients.
   */
  emitSignalApproved(signalId: string): void {
    this.server.emit('auto-trade:signal-approved', { signalId });
  }

  /**
   * Emit signal rejected event to all connected clients.
   */
  emitSignalRejected(signalId: string): void {
    this.server.emit('auto-trade:signal-rejected', { signalId });
  }

  /**
   * Emit auto-trade executed event with trade details.
   */
  emitAutoTradeExecuted(trade: Record<string, any>): void {
    this.server.emit('auto-trade:executed', trade);
  }

  /**
   * Emit scan complete event with scan statistics.
   */
  emitScanComplete(stats: Record<string, any>): void {
    this.server.emit('auto-trade:scan-complete', stats);
  }

  /**
   * Emit auto-trade error event to all connected clients.
   */
  emitAutoTradeError(error: { message: string; signalId?: string }): void {
    this.logger.error(
      `Auto-trade error: ${error.message}${error.signalId ? ` (signal: ${error.signalId})` : ''}`,
    );
    this.server.emit('auto-trade:error', error);
  }
}
