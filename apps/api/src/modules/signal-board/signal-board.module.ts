import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SignalBoardController } from './controllers/signal-board.controller';
import { SignalBoardRepository } from './repositories/signal-board.repository';
import { SignalBoardService } from './services/signal-board.service';

/** Signal board: one read-only list of a session's signals from every source. Reads only. */
@Module({
  imports: [PrismaModule],
  controllers: [SignalBoardController],
  providers: [SignalBoardRepository, SignalBoardService],
})
export class SignalBoardModule {}
