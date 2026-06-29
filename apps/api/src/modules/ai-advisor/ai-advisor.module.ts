import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AIAdvisorController } from './controllers/ai-advisor.controller';
import { AIAdvisorService } from './services/ai-advisor.service';
import { WeeklyReportService } from './services/weekly-report.service';

@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [AIAdvisorController],
  providers: [AIAdvisorService, WeeklyReportService],
  exports: [AIAdvisorService, WeeklyReportService],
})
export class AIAdvisorModule {}
