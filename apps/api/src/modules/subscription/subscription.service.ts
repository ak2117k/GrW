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

  /**
   * The unwrapped "is this segment active?" query body. Does NOT manage the
   * tenant bypass itself — callers MUST run it inside a `runWithoutTenant`
   * scope. Keeping the bypass out of here lets {@link listForUser} run BOTH
   * segment checks under a SINGLE bypass scope: two concurrent
   * `runWithoutTenant` calls on the same shared CLS store race their
   * capture/restore and can leave the request's real tenant context wiped
   * (cross-tenant leak).
   */
  private async queryActive(userId: string, segment: Seg): Promise<boolean> {
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
  }

  hasActive(userId: string, segment: Seg): Promise<boolean> {
    return this.tenant.runWithoutTenant(() =>
      this.queryActive(userId, segment),
    );
  }

  listForUser(
    userId: string,
  ): Promise<{ INTRADAY: boolean; SWING: boolean }> {
    return this.tenant.runWithoutTenant(async () => {
      const [intraday, swing] = await Promise.all([
        this.queryActive(userId, 'INTRADAY'),
        this.queryActive(userId, 'SWING'),
      ]);
      return { INTRADAY: intraday, SWING: swing };
    });
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
