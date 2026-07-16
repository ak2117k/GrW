import {
  Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post,
  UnauthorizedException, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../../common/decorators';
import { ChartinkIngestService } from '../services/chartink-ingest.service';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';

/** Header carrying the shared secret. Set it on the Chartink alert destination. */
export const CHARTINK_SECRET_HEADER = 'x-chartink-webhook-secret';

// External machine-to-machine endpoint: Chartink cannot present a Bearer JWT.
// It authenticates via a constant-time shared-secret check below, so opt this
// controller out of the global JwtAuthGuard.
//
// The secret arrives in CHARTINK_SECRET_HEADER and NEVER in the URL. It used to
// be a path segment, which meant everything that records request paths logged it
// verbatim — the global LoggingInterceptor on success, the HttpExceptionFilter on
// every 401, plus the platform access logs outside this process. Those logs ship
// to a third party and this secret is the entire auth boundary for a @Public()
// route, so the URL is the one place it must not go.
@Public()
@Controller('webhooks/chartink')
export class ChartinkWebhookController {
  private readonly logger = new Logger(ChartinkWebhookController.name);

  constructor(
    private readonly ingest: ChartinkIngestService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }))
  async receive(
    @Headers(CHARTINK_SECRET_HEADER) providedSecret: string | undefined,
    @Body() body: ChartinkWebhookDto,
  ): Promise<{ received: true; alertId: string; hitCount: number }> {
    const expected = this.config.get<string>('CHARTINK_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.warn('CHARTINK_WEBHOOK_SECRET is not configured — rejecting all webhooks');
      throw new UnauthorizedException();
    }
    // A header can be absent outright, unlike the path param this replaced.
    // Normalise so a missing one is a clean 401, not a 500 off `undefined.length`.
    const provided = providedSecret ?? '';
    if (!this.constantTimeEqual(provided, expected)) {
      this.logger.warn(`Chartink webhook auth failed (provided length=${provided.length})`);
      throw new UnauthorizedException();
    }

    const result = await this.ingest.ingest(body);
    return { received: true, ...result };
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
