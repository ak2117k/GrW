import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { SignalBoard } from '../domain/signal-board';
import { SignalBoardService } from '../services/signal-board.service';

/**
 * GET /api/signal-board?date=YYYY-MM-DD (default today, IST): the Signals page — the night's setups
 * and ideas plus the day's Telegram calls and breakout watches, in one list. Authenticated by the
 * global JwtAuthGuard and scoped to the caller.
 */
@Controller('api/signal-board')
export class SignalBoardController {
  constructor(private readonly service: SignalBoardService) {}

  @Get()
  get(@CurrentUser('userId') userId: string, @Query('date') date?: string): Promise<SignalBoard> {
    return this.service.board(userId, date);
  }
}
