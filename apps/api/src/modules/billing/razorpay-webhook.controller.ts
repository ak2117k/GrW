import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/decorators';
import { BillingWebhookService } from './billing-webhook.service';

/**
 * Razorpay webhook endpoint (TDA-015 §5). Mirrors the Chartink webhook's
 * auth/opt-out shape: `@Public()` (bypasses the global JwtAuthGuard),
 * `@HttpCode(200)`, no `/api` prefix. Unauthenticated but cryptographically
 * verified — the HMAC is over the RAW request bytes (captured via the app's
 * `rawBody: true` setting), so this reads `req.rawBody`, NOT the parsed body.
 */
@Public()
@Controller('webhooks/razorpay')
export class RazorpayWebhookController {
  constructor(private readonly webhook: BillingWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      // No raw bytes → cannot verify → reject (never trust the parsed body).
      throw new UnauthorizedException('Missing raw body');
    }
    return this.webhook.handle(rawBody, signature ?? '');
  }
}
