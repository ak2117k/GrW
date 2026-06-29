import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AIAdvisorService } from '../services/ai-advisor.service';
import { WeeklyReportService } from '../services/weekly-report.service';
import {
  AskQuestionDto,
  AnalyzeTradeParamDto,
  ReportIdParamDto,
  GetReportsDto,
} from '../dto/ai-advisor.dto';

@ApiTags('AI Advisor')
@Controller('api/advisor')
export class AIAdvisorController {
  constructor(
    private readonly advisorService: AIAdvisorService,
    private readonly weeklyReportService: WeeklyReportService,
  ) {}

  @Post('ask')
  @ApiOperation({ summary: 'Ask the AI advisor a question' })
  @ApiResponse({ status: 200, description: 'AI response returned' })
  async askQuestion(@Body() dto: AskQuestionDto) {
    return this.advisorService.askQuestion(dto.question);
  }

  @Get('insights')
  @ApiOperation({ summary: 'Get current AI-generated insights' })
  @ApiResponse({ status: 200, description: 'Insights list returned' })
  async getInsights() {
    return this.advisorService.getInsights();
  }

  @Get('reports')
  @ApiOperation({ summary: 'Get recent weekly reports' })
  @ApiResponse({ status: 200, description: 'Reports list returned' })
  async getReports(@Query() dto: GetReportsDto) {
    return this.weeklyReportService.getReports(dto.limit ?? 10);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Get a single weekly report' })
  @ApiResponse({ status: 200, description: 'Report returned' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getReportById(@Param() params: ReportIdParamDto) {
    const report = await this.weeklyReportService.getReportById(params.id);
    if (!report) {
      throw new HttpException('Report not found', HttpStatus.NOT_FOUND);
    }
    return report;
  }

  @Post('analyze-trade/:tradeId')
  @ApiOperation({ summary: 'Analyze a specific trade with AI' })
  @ApiResponse({ status: 200, description: 'Trade analysis returned' })
  @ApiResponse({ status: 404, description: 'Trade not found' })
  async analyzeTrade(@Param() params: AnalyzeTradeParamDto) {
    try {
      return await this.advisorService.analyzeTrade(params.tradeId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Analysis failed';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Get AI trading suggestions' })
  @ApiResponse({ status: 200, description: 'Suggestions returned' })
  async getSuggestions() {
    return this.advisorService.getTradingSuggestions();
  }

  @Post('generate-report')
  @ApiOperation({ summary: 'Manually trigger weekly report generation' })
  @ApiResponse({ status: 201, description: 'Report generated' })
  async generateReport() {
    return this.weeklyReportService.generateWeeklyReport();
  }
}
