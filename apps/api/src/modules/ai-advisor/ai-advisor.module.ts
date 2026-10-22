import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AIAdvisorController } from './controllers/ai-advisor.controller';
import { AIAdvisorService } from './services/ai-advisor.service';
import { WeeklyReportService } from './services/weekly-report.service';

import { AiAssistModule } from '../ai-assist/ai-assist.module';

@Module({
  // AiAssistModule: Claude-session chat + guardrail for POST /api/advisor/ask.
  // It also registers the News page's in-process insight processor.
  imports: [PrismaModule, HttpModule, AiAssistModule],
  controllers: [AIAdvisorController],
  providers: [AIAdvisorService, WeeklyReportService],
  exports: [AIAdvisorService, WeeklyReportService],
})
export class AIAdvisorModule {}
