import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { InsightsController } from './controllers/insights.controller';
import { InsightsService } from './services/insights.service';
import { InsightsRepository } from './repositories/insights.repository';

@Module({
  imports: [PrismaModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRepository],
  exports: [InsightsService],
})
export class InsightsModule {}
