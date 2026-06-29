import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { BrokerService } from '../services/broker.service';
import { SaveBrokerCredentialsDto } from '../dto/broker.dto';

@Controller('api/broker')
export class BrokerController {
  constructor(private readonly brokerService: BrokerService) {}

  @Post('credentials')
  async saveCredentials(@Body() dto: SaveBrokerCredentialsDto) {
    return this.brokerService.saveCredentials(dto);
  }

  /**
   * POST /api/broker/test-connection
   *
   * Triggers a real broker login using whatever credentials the auth
   * service currently has cached (saved DB row first, .env fallback).
   * The frontend sends {apiKey, clientId} as a hint but we don't use
   * them directly — full auth needs password + TOTP secret too, which
   * only live in the broker_credentials table or .env. A successful
   * return means the SmartAPI session was established.
   */
  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  async testConnection(@Body() _body: { apiKey?: string; clientId?: string }) {
    const result = await this.brokerService.connect();
    return { ok: true, ...result };
  }

  @Post('connect')
  async connect() {
    return this.brokerService.connect();
  }

  @Post('disconnect')
  async disconnect() {
    return this.brokerService.disconnect();
  }

  @Get('status')
  async getStatus() {
    return this.brokerService.getStatus();
  }

  @Get('account')
  async getAccountInfo() {
    return this.brokerService.getAccountInfo();
  }

  @Get('credentials')
  async getSavedCredentials() {
    return this.brokerService.getSavedCredentials();
  }
}
