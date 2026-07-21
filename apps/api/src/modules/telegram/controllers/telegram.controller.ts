import { Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../../../common/decorators';
import { TelegramRepository } from '../repositories/telegram.repository';
import { TelegramStatsService } from '../services/telegram-stats.service';

@AdminOnly()
@Controller('api/telegram')
export class TelegramController {
  constructor(
    private readonly repo: TelegramRepository,
    private readonly stats: TelegramStatsService,
  ) {}

  @Get('channels') listChannels() { return this.repo.listChannels(); }
  @Get('leaderboard') leaderboard() { return this.stats.channelScorecards(); }

  @Get('signals')
  listSignals(
    @Query('channelId') channelId?: string,
    @Query('status') status?: string,
    @Query('limit') limit = '50',
  ) {
    return this.repo.listSignals({ channelId, status, limit: Math.min(Number(limit) || 50, 200) });
  }
}
