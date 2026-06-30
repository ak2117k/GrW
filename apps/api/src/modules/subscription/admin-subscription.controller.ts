import { Body, Controller, Delete, Post } from '@nestjs/common';
import { AdminOnly } from '../../common/decorators';
import { SubscriptionService, Seg } from './subscription.service';

/**
 * ADMIN-only plan-gate management (TDA-007). Grants/revokes a user's segment
 * subscription. `@AdminOnly()` is enforced by the global RolesGuard.
 */
@AdminOnly()
@Controller('api/admin/subscriptions')
export class AdminSubscriptionController {
  constructor(private readonly subs: SubscriptionService) {}

  @Post()
  async grant(@Body() b: { userId: string; segment: Seg; expiresAt?: string }) {
    await this.subs.grant(
      b.userId,
      b.segment,
      b.expiresAt ? new Date(b.expiresAt) : null,
    );
    return { ok: true };
  }

  @Delete()
  async revoke(@Body() b: { userId: string; segment: Seg }) {
    await this.subs.revoke(b.userId, b.segment);
    return { ok: true };
  }
}
