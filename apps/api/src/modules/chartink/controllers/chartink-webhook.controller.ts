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
//
// THE SECRET IS IN THE URL, and that is a known, accepted-for-now exposure:
// anything recording request paths captures it, including the hosting platform's
// access logs, which are outside this process. Our own logs are covered —
// redactSecretPath/redactSecretsInText scrub /webhooks/* out of the request log,
// the error body and the stack (see common/utils/redact-secret-path.ts).
//
// This was briefly migrated to a header (the right end state, and what
// MlTriggerController and RazorpayWebhookController do) and reverted: the URL
// lives in Chartink's alert config, a third party that has to be reconfigured BY
// HAND, so shipping the code first 404'd every live alert. Redo it sender-first:
// reconfigure Chartink to send X-Chartink-Webhook-Secret, confirm it arrives,
// THEN drop the path param. Rotate the secret when you do — it has been logged.
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
    @Param('secret') providedSecret: string | undefined,
    @Body() body: ChartinkWebhookDto,
  ): Promise<{ received: true; alertId: string; hitCount: number }> {
    const expected = this.config.get<string>('CHARTINK_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.warn('CHARTINK_WEBHOOK_SECRET is not configured — rejecting all webhooks');
      throw new UnauthorizedException();
    }
    // Normalised even though a path param is always a string: it costs nothing
    // and keeps a missing/odd value a clean 401 rather than a 500 off .length.
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
