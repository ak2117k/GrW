import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { ChartinkScoringService, type SetupSide } from '../services/chartink-scoring.service';
import { ChartinkRejectionsService } from '../services/chartink-rejections.service';

@Controller('api/chartink')
export class ChartinkController {
  constructor(
    private readonly repo: ChartinkRepository,
    private readonly scoring: ChartinkScoringService,
    private readonly rejections: ChartinkRejectionsService,
  ) {}

  /**
   * Surfaces Chartink alert setups that did not result in a trade, with
   * aggregate counts by rejection kind. All query params optional:
   * `from` (ISO), `to` (ISO), `kind` (string), `limit` (number).
   */
  @Get('rejections')
  async getRejections(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit != null ? parseInt(limit, 10) : undefined;
    return this.rejections.getRejections({
      from: from || undefined,
      to: to || undefined,
      kind: kind || undefined,
      limit: parsedLimit != null && !Number.isNaN(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get('scanners')
  async listScanners() {
    return this.repo.listScanners();
  }

  @Get('alerts')
  async listAlerts(@Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    return this.repo.listRecentAlerts(n);
  }

  @Get('alerts/:id')
  async getAlert(@Param('id') id: string) {
    const alert = await this.repo.getAlertWithSetups(id);
    if (!alert) throw new NotFoundException(`Chartink alert ${id} not found`);
    return alert;
  }

  /**
   * DEBUG endpoint — manually invoke the scoring service against any
   * (token, symbol, side, entryPrice) combination. Useful for verifying
   * scoring logic outside market hours when analyze() won't produce a
   * setup. Doesn't persist anything.
   */
  @Post('debug/score-preview')
  @HttpCode(HttpStatus.OK)
  async scorePreview(
    @Body() body: {
      token: string;
      symbol: string;
      exchange?: string;
      side: SetupSide;
      entryPrice: number;
      // Optional level book snapshot for the S/R room check
      levelBookSnapshot?: {
        pdh: number;
        pdl: number;
        orh: number | null;
        orl: number | null;
        vwap: number;
      };
    },
  ) {
    const result = await this.scoring.score({
      token: body.token,
      symbol: body.symbol,
      exchange: body.exchange ?? 'NSE',
      side: body.side,
      entryPrice: body.entryPrice,
      setupContext: body.levelBookSnapshot
        ? { levelBookSnapshot: body.levelBookSnapshot }
        : null,
    });
    return result;
  }
}
