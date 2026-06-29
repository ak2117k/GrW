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
import { Trade } from '@prisma/client';
import { DailyRiskStatus } from '../dto/trade.dto';
import { Position } from '@td/shared/types';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

@WebSocketGateway({
  namespace: `${WS_NAMESPACE}/trades`,
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
})
export class TradeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TradeGateway.name);

  @WebSocketServer()
  server: Server;

  private connectedClients = 0;

  afterInit(): void {
    this.logger.log('Trade WebSocket Gateway initialized');
  }

  handleConnection(_client: Socket): void {
    this.connectedClients++;
    this.logger.log(
      `Trade WS client connected (total: ${this.connectedClients})`,
    );
  }

  handleDisconnect(_client: Socket): void {
    this.connectedClients--;
    this.logger.log(
      `Trade WS client disconnected (total: ${this.connectedClients})`,
    );
  }

  /**
   * Emit trade update (new, modified, or closed trade) to all connected clients.
   */
  emitTradeUpdate(trade: Trade): void {
    this.server.emit('trade-update', trade);
  }

  /**
   * Emit live position updates with current P&L to all connected clients.
   */
  emitPositionUpdate(positions: Position[]): void {
    this.server.emit('position-update', positions);
  }

  /**
   * Emit current daily risk status to all connected clients.
   */
  emitRiskStatus(status: DailyRiskStatus): void {
    this.server.emit('risk-status', status);
  }

  /**
   * Broadcast kill switch activation to all connected clients.
   */
  emitKillSwitchActivated(reason: string): void {
    this.logger.warn(`Kill switch activated: ${reason}`);
    this.server.emit('kill-switch-activated', {
      reason,
      timestamp: new Date(),
    });
  }
}
