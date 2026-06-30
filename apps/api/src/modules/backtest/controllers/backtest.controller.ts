import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { BacktestService } from '../services/backtest.service';
import { RunBacktestDto, CompareStrategiesDto } from '../dto/backtest.dto';
import { AdminOnly } from '../../../common/decorators';

@AdminOnly()
@Controller('api/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  /**
   * POST /api/backtest/run — Run a single backtest
   */
  @Post('run')
  async runBacktest(@Body() dto: RunBacktestDto) {
    const result = await this.backtestService.runBacktest(dto);
    return { data: result };
  }

  /**
   * POST /api/backtest/compare — Compare multiple strategies
   */
  @Post('compare')
  async compareStrategies(@Body() dto: CompareStrategiesDto) {
    const result = await this.backtestService.compareStrategies(dto.configs);
    return { data: result };
  }

  /**
   * GET /api/backtest — History of backtest runs
   */
  @Get()
  async getHistory(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const runs = await this.backtestService.getBacktestHistory(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return { data: runs };
  }

  /**
   * GET /api/backtest/:id — Single backtest detail
   */
  @Get(':id')
  async getById(@Param('id') id: string) {
    const run = await this.backtestService.getBacktestById(id);
    return { data: run };
  }

  /**
   * DELETE /api/backtest/:id — Delete a backtest run
   */
  @Delete(':id')
  async deleteBacktest(@Param('id') id: string) {
    const result = await this.backtestService.deleteBacktest(id);
    return { data: result };
  }
}
