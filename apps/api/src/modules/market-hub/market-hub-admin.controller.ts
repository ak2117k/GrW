import { BadRequestException, Controller, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import type { FixupReport } from './candles/candle-store';
import { MarketHubService } from './market-hub.service';

/**
 * POST /api/admin/market-hub/fixup?day=YYYY-MM-DD — run the candle fix-up for one IST day now and
 * return its report (bars fetched vs written per table, empty windows, samples). ADMIN only. Leased
 * like the 00:15 cron, so it never overlaps it; `report: null` = candles off or the lease is held.
 */
@Controller('api/admin/market-hub')
export class MarketHubAdminController {
  constructor(private readonly hub: MarketHubService) {}

  @Post('fixup')
  @Roles('ADMIN')
  async fixup(@Query('day') day?: string): Promise<{ day: string; report: FixupReport | null }> {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException('day=YYYY-MM-DD is required');
    return { day, report: await this.hub.candleFixup(day) };
  }
}
