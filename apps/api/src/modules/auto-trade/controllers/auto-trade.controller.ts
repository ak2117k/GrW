import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { AutoTradeService } from '../services/auto-trade.service';

@Controller('api/auto-trade')
export class AutoTradeController {
  constructor(private readonly autoTradeService: AutoTradeService) {}

  @Get('status')
  async getStatus() {
    return this.autoTradeService.getAutoTradeStatus();
  }

  @Get('pending')
  getPendingApprovals() {
    return this.autoTradeService.getPendingApprovals();
  }

  @Post('approve/:signalId')
  @HttpCode(HttpStatus.OK)
  async approveSignal(@Param('signalId') signalId: string) {
    const trade = await this.autoTradeService.approveSignal(signalId);
    if (!trade) {
      throw new HttpException(
        `Signal ${signalId} not found in pending approvals`,
        HttpStatus.NOT_FOUND,
      );
    }
    return trade;
  }

  @Post('reject/:signalId')
  @HttpCode(HttpStatus.OK)
  rejectSignal(@Param('signalId') signalId: string) {
    this.autoTradeService.rejectSignal(signalId);
    return { message: `Signal ${signalId} rejected` };
  }

  @Post('force-execute/:signalId')
  @HttpCode(HttpStatus.OK)
  async forceExecuteSignal(@Param('signalId') signalId: string) {
    const trade = await this.autoTradeService.forceExecuteSignal(signalId);
    if (!trade) {
      throw new HttpException(
        `Signal ${signalId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return trade;
  }

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async triggerScan() {
    await this.autoTradeService.periodicSignalScan();
    return this.autoTradeService.getAutoTradeStatus();
  }
}
