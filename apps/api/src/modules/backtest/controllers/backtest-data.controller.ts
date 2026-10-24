import { Body, Controller, ForbiddenException, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { AdminOnly, CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { BacktestDataService } from '../services/backtest-data.service';
import { DataAcquisitionService } from '../services/data-acquisition.service';
import { BacktestDataRepository } from '../repositories/backtest-data.repository';
import { BacktestAssistantService } from '../assistant/backtest-assistant.service';
import { BacktestLlmService } from '../assistant/backtest-llm.service';
import { AskBacktestAssistantDto, FetchBacktestDataDto } from '../dto/backtest-data.dto';

/**
 * Backtest data catalogue (everyone who sees the backtest page) and the owner-only parts: on-demand
 * history fetches over the owner's Angel session and "Ask Claude to backtest…".
 */
@AdminOnly()
@Controller('api/backtest')
export class BacktestDataController {
  private readonly logger = new Logger(BacktestDataController.name);

  constructor(
    private readonly data: BacktestDataService,
    private readonly repo: BacktestDataRepository,
    private readonly acquisition: DataAcquisitionService,
    private readonly assistant: BacktestAssistantService,
    private readonly llm: BacktestLlmService,
  ) {}

  /** GET /api/backtest/data/datasets — what history the store holds. */
  @Get('data/datasets')
  async datasets(@Query('symbol') symbol?: string) {
    return { data: await this.data.listDatasets(symbol || undefined) };
  }

  /** GET /api/backtest/data/fetch-jobs — recent on-demand fetches (progress, calls spent). */
  @Get('data/fetch-jobs')
  async fetchJobs() {
    return { data: await this.repo.recentFetchJobs(20) };
  }

  /** POST /api/backtest/data/fetch — owner only; starts a fetch and returns at once (poll fetch-jobs). */
  @Post('data/fetch')
  async fetch(@CurrentUser() user: AuthenticatedUser, @Body() dto: FetchBacktestDataDto) {
    if (!this.llm.allowed(user)) throw new ForbiddenException('Data fetches use the owner\'s broker session: owner only.');
    if (this.acquisition.isBusy()) return { data: { started: false, message: 'another data fetch is running' } };
    void this.acquisition
      .acquire(user.userId, { symbol: dto.symbol, exchange: dto.exchange, timeframe: dto.timeframe, from: dto.from, to: dto.to })
      .catch((err) => this.logger.error(`[backtest-fetch] crashed: ${err instanceof Error ? err.message : err}`));
    return { data: { started: true } };
  }

  /** GET /api/backtest/assistant/status — {allowed:false} for everyone but the owner. */
  @Get('assistant/status')
  async assistantStatus(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.assistant.status(user) };
  }

  /** POST /api/backtest/assistant/ask — owner only; returns the request row (poll it by id). */
  @Post('assistant/ask')
  async ask(@CurrentUser() user: AuthenticatedUser, @Body() dto: AskBacktestAssistantDto) {
    return { data: await this.assistant.ask(user, dto.prompt) };
  }

  @Get('assistant/requests')
  async recent(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.assistant.recent(user) };
  }

  @Get('assistant/requests/:id')
  async request(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return { data: await this.assistant.get(user, id) };
  }
}
