import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';

/**
 * Daily lapse sweep (TDA-015 §6) — the missed-webhook safety net that makes
 * `expiresAt` AUTHORITATIVE for gating. Even if a `halted`/`cancelled` webhook
 * is never delivered, any `ACTIVE` row whose `expiresAt` (already period-end +
 * grace) has passed is durably flipped to `EXPIRED` so a lapsed user cannot
 * silently retain access, and `listForUser` stays honest for admin views.
 *
 * Runs unscoped (`runWithoutTenant`) — it operates across all users with no
 * request context, like `SubscriptionService`. Each expired row is audited
 * (`BILLING_ACCESS_REVOKED_LAPSE`).
 */
@Injectable()
export class BillingSweepService {
  private readonly logger = new Logger(BillingSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /** Daily at 02:00 IST — after the trading day, before the next open. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Asia/Kolkata' })
  async runDailySweep(): Promise<void> {
    const { expired } = await this.expireLapsedSubscriptions();
    if (expired > 0) {
      this.logger.log(`Lapse sweep expired ${expired} subscription(s)`);
    }
  }

  /**
   * Flip every `ACTIVE` subscription whose `expiresAt < now` to `EXPIRED` and
   * audit each. Returns the count expired. Idempotent — a second run finds
   * nothing.
   */
  expireLapsedSubscriptions(): Promise<{ expired: number }> {
    return this.tenant.runWithoutTenant(async () => {
      const now = new Date();
      const lapsed = await this.prisma.subscription.findMany({
        where: { status: 'ACTIVE', expiresAt: { lt: now } },
        select: { userId: true, segment: true },
      });
      if (lapsed.length === 0) return { expired: 0 };

      await this.prisma.subscription.updateMany({
        where: { status: 'ACTIVE', expiresAt: { lt: now } },
        data: { status: 'EXPIRED' },
      });

      for (const row of lapsed) {
        await this.audit.append({
          action: AUDIT_ACTIONS.billing.BILLING_ACCESS_REVOKED_LAPSE,
          userId: row.userId,
          meta: { segment: row.segment, reason: 'EXPIRED_SWEEP' },
        });
      }

      return { expired: lapsed.length };
    });
  }
}
