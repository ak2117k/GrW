import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { TradeTrackerService } from '../services/trade-tracker.service';
import { DailyOhlcDto, SoldTradeDto } from '../dto/trade-tracker.dto';

/**
 * "Sold" surface for the Portfolio page (2026-07-13 sold-trades design). A
 * CLOSED trade-tracker row IS the persistent sold record. Both routes are
 * authenticated (global JwtAuthGuard) and scoped to the caller via
 * `@CurrentUser('userId')`.
 *
 *   GET /api/portfolio/sold          the caller's CLOSED trackers, newest exit first
 *   GET /api/portfolio/sold/:id/ohlc the sold trade's daily OHLC series
 */
@Controller('api/portfolio/sold')
export class SoldTradesController {
  constructor(private readonly service: TradeTrackerService) {}

  @Get()
  async list(
    @CurrentUser('userId') userId: string,
  ): Promise<{ sold: SoldTradeDto[] }> {
    return { sold: await this.service.listSold(userId) };
  }

  /**
   * Daily OHLC for one sold trade over its window (hold + short post-exit
   * tail). 404 if the tracker isn't the caller's; empty series on a data hiccup.
   */
  @Get(':id/ohlc')
  async ohlc(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<{ symbol: string; ohlc: DailyOhlcDto[] }> {
    return this.service.listSoldOhlc(userId, id);
  }
}
