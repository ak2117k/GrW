import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { LevelBreakLogService } from './level-break-log.service';

/**
 * NIFTY level-break research log (research instrumentation only): records each S/R zone break with
 * the front-month futures OI around it and fills the follow-through later. Exports nothing; no
 * trading path reads level_break_log. LEVEL_BREAK_LOG=off disables both crons.
 */
@Module({
  imports: [PrismaModule],
  providers: [LevelBreakLogService],
})
export class LevelBreakLogModule {}
