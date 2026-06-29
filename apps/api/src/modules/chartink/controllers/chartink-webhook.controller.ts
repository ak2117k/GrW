import {
  Body, Controller, HttpCode, HttpStatus, Logger, Param, Post,
  UnauthorizedException, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../../common/decorators';
import { ChartinkIngestService } from '../services/chartink-ingest.service';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';

// External machine-to-machine endpoint: Chartink cannot present a Bearer JWT.
// It authenticates via a constant-time path-secret check below, so opt this
// controller out of the global JwtAuthGuard.
@Public()
@Controller('webhooks/chartink')
export class ChartinkWebhookController {
  private readonly logger = new Logger(ChartinkWebhookController.name);

  constructor(
    private readonly ingest: ChartinkIngestService,
    private readonly config: ConfigService,
  ) {}

  @Post(':secret')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }))
  async receive(
    @Param('secret') providedSecret: string,
    @Body() body: ChartinkWebhookDto,
  ): Promise<{ received: true; alertId: string; hitCount: number }> {
    const expected = this.config.get<string>('CHARTINK_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.warn('CHARTINK_WEBHOOK_SECRET is not configured — rejecting all webhooks');
      throw new UnauthorizedException();
    }
    if (!this.constantTimeEqual(providedSecret, expected)) {
      this.logger.warn(`Chartink webhook auth failed (provided length=${providedSecret.length})`);
      throw new UnauthorizedException();
    }

    const result = await this.ingest.ingest(body);
    return { received: true, ...result };
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
