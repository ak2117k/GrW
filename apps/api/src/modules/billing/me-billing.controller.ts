import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators';
import { BillingService, SegmentBillingStatus } from './billing.service';
import { CheckoutDto } from './dto/checkout.dto';

/**
 * USER-facing billing surface (TDA-015 §4). Authenticated; drives checkout /
 * cancel / status. Entitlement is NOT flipped here — checkout leaves the row
 * PAST_DUE and only the webhook (real payment) grants access.
 */
@Controller('api/me/billing')
export class MeBillingController {
  constructor(private readonly billing: BillingService) {}

  /** Create a Razorpay subscription + return the non-secret checkout payload. */
  @Post('checkout')
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDto) {
    return this.billing
      .createCheckout({ userId: user.userId, email: user.email }, dto.segment)
      .then((checkout) => ({ checkout }));
  }

  /** Request cancellation at cycle end (access persists until period end). */
  @Post('cancel')
  async cancel(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDto) {
    await this.billing.cancel(user.userId, dto.segment);
    return { cancelled: true, segment: dto.segment };
  }

  /** Per-segment billing status for the manage-billing UI. */
  @Get()
  status(@CurrentUser() user: AuthenticatedUser): Promise<SegmentBillingStatus[]> {
    return this.billing.getStatus(user.userId);
  }
}
