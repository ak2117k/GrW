import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import {
  CreateSubscriptionResult,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './providers/payment-provider.interface';

export type Seg = 'INTRADAY' | 'SWING';

/** The per-segment billing status the /me/billing surface returns. */
export interface SegmentBillingStatus {
  segment: Seg;
  status: string; // SubscriptionStatus (ACTIVE | PAST_DUE | CANCELLED | EXPIRED)
  active: boolean;
  expiresAt: string | null;
  graceUntil: string | null;
  hasProviderSub: boolean;
}

/**
 * Checkout/cancel orchestration + provider-state persistence (TDA-015 §4).
 *
 * BillingService NEVER flips entitlement — {@link SubscriptionService.grant} /
 * `revoke` are the only entitlement writers (driven by the webhook). This
 * service:
 *   - ensures a {@link BillingProfile} (Razorpay customer) + creates a provider
 *     subscription and stamps `providerSubId`/`providerPlanId` on the (user,
 *     segment) row at status `PAST_DUE` (NO access until the webhook confirms);
 *   - resolves `(userId, segment)` from a `providerSubId` for the webhook;
 *   - manages the `graceUntil` dunning column.
 *
 * `Subscription` / `BillingProfile` are TENANT_MODELS; billing runs across users
 * (the webhook worker has no tenant context), so every query is wrapped in
 * {@link TenantContextService.runWithoutTenant}.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create a checkout intent for `(user, segment)`: ensure the Razorpay customer,
   * create the provider subscription, upsert the gate row to `PAST_DUE` with the
   * provider ids (NO access yet), audit, and return the NON-secret checkout
   * payload for the browser.
   */
  async createCheckout(
    user: { userId: string; email: string },
    segment: Seg,
  ): Promise<CreateSubscriptionResult['checkout']> {
    const providerCustomerId = await this.ensureCustomer(user);

    const result = await this.provider.createSubscription({
      providerCustomerId,
      segment,
    });

    await this.tenant.runWithoutTenant(() =>
      this.prisma.subscription.upsert({
        where: { userId_segment: { userId: user.userId, segment } },
        // PAST_DUE — pending authorization. Access is granted ONLY when the
        // webhook confirms the first charge. Do NOT set status ACTIVE here.
        update: {
          status: 'PAST_DUE',
          providerSubId: result.providerSubId,
          providerPlanId: result.providerPlanId,
        },
        create: {
          userId: user.userId,
          segment,
          status: 'PAST_DUE',
          providerSubId: result.providerSubId,
          providerPlanId: result.providerPlanId,
        },
      }),
    );

    await this.audit.append({
      action: AUDIT_ACTIONS.billing.BILLING_CHECKOUT_CREATED,
      userId: user.userId,
      target: result.providerSubId,
      meta: { segment, providerPlanId: result.providerPlanId },
    });

    return result.checkout;
  }

  /**
   * Request cancellation at cycle end. Access persists until period end; the
   * eventual `subscription.cancelled` webhook revokes. Immediate cancel + refund
   * is the admin/ops path (§10.4).
   */
  async cancel(userId: string, segment: Seg): Promise<void> {
    const row = await this.tenant.runWithoutTenant(() =>
      this.prisma.subscription.findUnique({
        where: { userId_segment: { userId, segment } },
        select: { providerSubId: true },
      }),
    );
    if (!row?.providerSubId) {
      throw new NotFoundException('No active provider subscription for this segment');
    }

    await this.provider.cancelSubscription({
      providerSubId: row.providerSubId,
      atCycleEnd: true,
    });

    await this.audit.append({
      action: AUDIT_ACTIONS.billing.BILLING_CANCEL_REQUESTED,
      userId,
      target: row.providerSubId,
      meta: { segment, atCycleEnd: true },
    });
  }

  /** Per-segment billing status for the authenticated user's manage-billing UI. */
  async getStatus(userId: string): Promise<SegmentBillingStatus[]> {
    const rows = await this.tenant.runWithoutTenant(() =>
      this.prisma.subscription.findMany({
        where: { userId },
        select: {
          segment: true,
          status: true,
          expiresAt: true,
          graceUntil: true,
          providerSubId: true,
        },
      }),
    );
    const now = Date.now();
    return rows.map((r) => ({
      segment: r.segment as Seg,
      status: r.status,
      active:
        r.status === 'ACTIVE' &&
        (r.expiresAt === null || r.expiresAt.getTime() > now),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      graceUntil: r.graceUntil ? r.graceUntil.toISOString() : null,
      hasProviderSub: !!r.providerSubId,
    }));
  }

  /**
   * Resolve the `(userId, segment)` a Razorpay subscription id maps to. Unscoped
   * — the webhook worker has no tenant context. Returns null for an unknown sub.
   */
  resolveByProviderSubId(
    providerSubId: string,
  ): Promise<{ userId: string; segment: Seg } | null> {
    return this.tenant.runWithoutTenant(async () => {
      const row = await this.prisma.subscription.findUnique({
        where: { providerSubId },
        select: { userId: true, segment: true },
      });
      return row ? { userId: row.userId, segment: row.segment as Seg } : null;
    });
  }

  /**
   * Set/clear the `graceUntil` dunning window on a gate row (additive column;
   * does NOT touch entitlement). Unscoped.
   */
  setGraceUntil(userId: string, segment: Seg, graceUntil: Date | null): Promise<void> {
    return this.tenant.runWithoutTenant(async () => {
      await this.prisma.subscription.updateMany({
        where: { userId, segment },
        data: { graceUntil },
      });
    });
  }

  /**
   * Ensure a {@link BillingProfile} exists for the user, creating a Razorpay
   * customer on first use. Idempotent.
   */
  private async ensureCustomer(user: {
    userId: string;
    email: string;
  }): Promise<string> {
    const existing = await this.tenant.runWithoutTenant(() =>
      this.prisma.billingProfile.findUnique({
        where: { userId: user.userId },
        select: { providerCustomerId: true },
      }),
    );
    if (existing) return existing.providerCustomerId;

    const { providerCustomerId } = await this.provider.createCustomer({
      userId: user.userId,
      email: user.email,
    });

    await this.tenant.runWithoutTenant(() =>
      this.prisma.billingProfile.upsert({
        where: { userId: user.userId },
        update: {},
        create: { userId: user.userId, providerCustomerId },
      }),
    );
    return providerCustomerId;
  }

  /** Grace window length in ms (from `billing.graceDays`, default 3). */
  graceMs(): number {
    const days = this.config.get<number>('billing.graceDays') ?? 3;
    return days * 86_400_000;
  }
}
