import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PortfolioService } from '../services/portfolio.service';
import { DateRangeDto, JournalFilterDto, MonthlyReportDto } from '../dto/portfolio.dto';

@ApiTags('Portfolio')
@Controller('api/portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get overall portfolio summary' })
  @ApiResponse({ status: 200, description: 'Portfolio summary returned' })
  async getSummary() {
    return this.portfolioService.getSummary();
  }

  @Get('equity-curve')
  @ApiOperation({ summary: 'Get equity curve data' })
  @ApiResponse({ status: 200, description: 'Equity curve data returned' })
  async getEquityCurve(@Query() dto: DateRangeDto) {
    const now = new Date();
    const from = dto.from ? new Date(dto.from) : new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const to = dto.to ? new Date(dto.to) : now;
    return this.portfolioService.getEquityCurve(from, to);
  }

  @Get('daily-pnl')
  @ApiOperation({ summary: 'Get daily P&L data' })
  @ApiResponse({ status: 200, description: 'Daily P&L data returned' })
  async getDailyPnl(@Query() dto: DateRangeDto) {
    const now = new Date();
    const from = dto.from ? new Date(dto.from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = dto.to ? new Date(dto.to) : now;
    return this.portfolioService.getDailyPnL(from, to);
  }

  @Get('segments')
  @ApiOperation({ summary: 'Get P&L breakdown by segment' })
  @ApiResponse({ status: 200, description: 'Segment breakdown returned' })
  async getSegments() {
    return this.portfolioService.getSegmentBreakdown();
  }

  @Get('strategies')
  @ApiOperation({ summary: 'Get performance by strategy' })
  @ApiResponse({ status: 200, description: 'Strategy performance returned' })
  async getStrategies() {
    return this.portfolioService.getStrategyPerformance();
  }

  @Get('journal')
  @ApiOperation({ summary: 'Get trade journal (paginated, filtered)' })
  @ApiResponse({ status: 200, description: 'Trade journal returned' })
  async getJournal(@Query() dto: JournalFilterDto) {
    return this.portfolioService.getTradeJournal({
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      strategy: dto.strategy,
      segment: dto.segment,
      status: dto.status,
      side: dto.side,
      vixRegime: dto.vixRegime,
      exitReasonTag: dto.exitReasonTag,
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      sortBy: dto.sortBy ?? 'date',
      order: dto.order ?? 'desc',
    });
  }

  @Get('monthly-report')
  @ApiOperation({ summary: 'Get monthly performance report' })
  @ApiResponse({ status: 200, description: 'Monthly report returned' })
  async getMonthlyReport(@Query() dto: MonthlyReportDto) {
    return this.portfolioService.getMonthlyReport(dto.year, dto.month);
  }
}
