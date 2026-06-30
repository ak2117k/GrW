import { Controller, Get } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators';
import { SubscriptionService } from './subscription.service';

/**
 * USER-facing plan-gate status (TDA-007). Returns the caller's per-segment
 * subscription booleans; authenticated, no special role required.
 */
@Controller('api/me/subscriptions')
export class MeSubscriptionController {
  constructor(private readonly subs: SubscriptionService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.listForUser(user.userId);
  }
}
