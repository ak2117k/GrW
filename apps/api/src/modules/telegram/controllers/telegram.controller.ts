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

  /** Every incoming message with its classification (and call + decision); `status` is a comma list. */
  @Get('feed')
  feed(
    @Query('channelId') channelId?: string,
    @Query('status') status?: string,
    @Query('limit') limit = '100',
  ) {
    const statuses = status ? status.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return this.repo.feed({ channelId, statuses, limit: Number(limit) || 100 });
  }
}
