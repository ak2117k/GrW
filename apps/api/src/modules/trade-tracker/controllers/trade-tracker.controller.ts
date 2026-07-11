import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { TradeTrackerService } from '../services/trade-tracker.service';
import { TradeTrackerDto } from '../dto/trade-tracker.dto';

/**
 * Per-trade tracker surface for the Portfolio page (design §5). Both routes are
 * authenticated (global JwtAuthGuard) and scoped to the caller via
 * `@CurrentUser('userId')`.
 *
 *   GET  /api/portfolio/trackers          the caller's trackers (OPEN + CLOSED)
 *   POST /api/portfolio/trackers/refresh  on-demand backfill+reconcile, fresh list
 */
@Controller('api/portfolio/trackers')
export class TradeTrackerController {
  constructor(private readonly service: TradeTrackerService) {}

  @Get()
  async list(
    @CurrentUser('userId') userId: string,
  ): Promise<{ trackers: TradeTrackerDto[] }> {
    return { trackers: await this.service.list(userId) };
  }

  /**
   * Force a fill for the caller (snapshot the current book + reconcile) so the
   * page can populate without waiting for the cron, then return the fresh list.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @CurrentUser('userId') userId: string,
  ): Promise<{ trackers: TradeTrackerDto[] }> {
    await this.service.backfill(userId);
    return { trackers: await this.service.list(userId) };
  }
}
