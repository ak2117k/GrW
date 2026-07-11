import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { StockMonitorService } from '../services/stock-monitor.service';
import {
  CreateStockMonitorDto,
  StockMonitorDto,
} from '../dto/stock-monitor.dto';

/**
 * Target-profit stock monitor surface for the `/monitor` page (design §4.4).
 * All routes are authenticated (global JwtAuthGuard) and scoped to the caller
 * via `@CurrentUser('userId')`.
 *
 *   POST   /api/monitor       add a stock to monitor        → StockMonitorDto
 *   GET    /api/monitor       the caller's monitors         → { monitors }
 *   DELETE /api/monitor/:id   remove a monitor              → 204
 */
@Controller('api/monitor')
export class StockMonitorController {
  constructor(private readonly service: StockMonitorService) {}

  @Post()
  async add(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateStockMonitorDto,
  ): Promise<StockMonitorDto> {
    return this.service.add(userId, dto);
  }

  @Get()
  async list(
    @CurrentUser('userId') userId: string,
  ): Promise<{ monitors: StockMonitorDto[] }> {
    return { monitors: await this.service.list(userId) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.service.remove(userId, id);
  }
}
