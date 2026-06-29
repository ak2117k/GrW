import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { FundamentalsService } from './fundamentals.service';
import type { FundamentalsResponse } from './types';

@ApiTags('Fundamentals')
@Controller('api/fundamentals')
export class FundamentalsController {
  constructor(private readonly fundamentals: FundamentalsService) {}

  /**
   * GET /api/fundamentals/:symbol?exchange=NSE
   *
   * Returns Yahoo-sourced fundamentals for the given equity. Cached for 24h
   * in-memory per `${exchange}:${symbol}` key (see FundamentalsService).
   *
   * Failures from Yahoo bubble up as 503 ServiceUnavailableException with
   * body `{ error: 'fundamentals_unavailable', message: '<reason>' }` —
   * the frontend's `useFundamentals` hook reads that to render a Retry UI.
   */
  @Get(':symbol')
  @ApiOperation({ summary: 'Fetch fundamentals for a stock from Yahoo Finance (24h cache)' })
  @ApiParam({ name: 'symbol', description: 'Stock symbol, e.g. RELIANCE' })
  @ApiQuery({ name: 'exchange', required: false, enum: ['NSE', 'BSE'] })
  @ApiResponse({ status: 200, description: 'Fundamentals snapshot' })
  @ApiResponse({ status: 503, description: 'Upstream Yahoo Finance unavailable' })
  async getFundamentals(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange: string = 'NSE',
  ): Promise<FundamentalsResponse> {
    if (!symbol || !symbol.trim()) {
      throw new BadRequestException('symbol is required');
    }
    const ex = exchange.toUpperCase();
    if (ex !== 'NSE' && ex !== 'BSE') {
      throw new BadRequestException(`exchange must be NSE or BSE, got "${exchange}"`);
    }
    return this.fundamentals.get(symbol, ex);
  }
}
