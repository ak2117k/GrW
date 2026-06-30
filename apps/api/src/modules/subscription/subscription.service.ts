import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/** The two plan-gated segments (TDA-007). */
export type Seg = 'INTRADAY' | 'SWING';

/**
 * Plan-gating service over the `Subscription` table (TDA-007).
 *
 * `Subscription` is a TENANT_MODEL (TDA-003) — the Prisma scoper would
 * auto-filter it by the request's `userId`. This service operates ACROSS users
 * (admin grant/revoke) and always checks an EXPLICIT `userId`, so every query is
 * wrapped in {@link TenantContextService.runWithoutTenant} to bypass that
 * scoping. "Active" means `status === 'ACTIVE'` AND (`expiresAt == null` OR
 * `expiresAt > now`).
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  hasActive(userId: string, segment: Seg): Promise<boolean> {
    return this.tenant.runWithoutTenant(async () => {
      const row = await this.prisma.subscription.findFirst({
        where: {
          userId,
          segment,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      });
      return !!row;
    });
  }

  async listForUser(
    userId: string,
  ): Promise<{ INTRADAY: boolean; SWING: boolean }> {
    const [intraday, swing] = await Promise.all([
      this.hasActive(userId, 'INTRADAY'),
      this.hasActive(userId, 'SWING'),
    ]);
    return { INTRADAY: intraday, SWING: swing };
  }

  grant(
    userId: string,
    segment: Seg,
    expiresAt: Date | null = null,
  ): Promise<void> {
    return this.tenant.runWithoutTenant(async () => {
      await this.prisma.subscription.upsert({
        where: { userId_segment: { userId, segment } },
        update: { status: 'ACTIVE', expiresAt },
        create: { userId, segment, status: 'ACTIVE', expiresAt },
      });
    });
  }

  revoke(userId: string, segment: Seg): Promise<void> {
    return this.tenant.runWithoutTenant(async () => {
      await this.prisma.subscription.updateMany({
        where: { userId, segment },
        data: { status: 'CANCELLED' },
      });
    });
  }
}
