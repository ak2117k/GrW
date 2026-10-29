import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NewsEventsCoreModule } from '../news-events/news-events-core.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { TICK_SOURCE } from '../trade-sentinel/services/sentinel-cycle.service';
import { PAPER_TICK_ROWS, PaperSentinelService } from './paper-sentinel.service';

/**
 * Paper exit shadow stage 2 — the live AI sentinel on paper trades (paper-sentinel.service.ts).
 * Its own module, not inside trade-sentinel: it replays the live EXIT paths too (sentinel-executor's
 * pure trigger rules and the exit gate's reads), and trade-sentinel may never import the executor (R14).
 */
@Module({
  imports: [PrismaModule, TradeSentinelModule, NewsEventsCoreModule],
  providers: [{ provide: PAPER_TICK_ROWS, useExisting: TICK_SOURCE }, PaperSentinelService],
  exports: [PaperSentinelService],
})
export class PaperSentinelModule {}
