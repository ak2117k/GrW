import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import type { Segment } from '../dto/public-signal.dto';

/**
 * A user eligible for fan-out of `segment`, plus the per-user risk knobs carried
 * so TDA-011 can size to per-user capital without a second query.
 */
export interface EligibleUser {
  userId: string;
  riskPerTrade: number | null;
  maxCapital: number | null;
}

/**
 * Computes the fan-out eligibility set (TDA-010 §4): the users who, for a given
 * segment, are ACTIVE-subscribed AND auto-on (`enabled && !killSwitch`) AND
 * connected (`BrokerCredential.isActive`).
 *
 * This is a COARSE pre-filter for fan-out efficiency, NOT a security boundary —
 * a subscription can expire or a kill switch can flip between this query and the
 * execute-user job running, so TDA-011 re-checks every gate authoritatively.
 * Fail-closed by construction: only users the single join positively confirms on
 * all three predicates are returned.
 *
 * Runs UNSCOPED (across all tenants) via `runWithoutTenant`, like
 * SubscriptionService — the fan-out worker has no request/tenant context.
 */
@Injectable()
export class FanoutEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
  ) {}

  eligibleUserIds(segment: Segment): Promise<EligibleUser[]> {
    // Fan-out runs in a background Bull worker with NO request/tenant CLS scope,
    // where Prisma is already unscoped — query directly. If a caller DOES hold an
    // active tenant scope (e.g. an admin endpoint), bypass it explicitly so
    // eligibility always reads across ALL users. runWithoutTenant mutates the CLS
    // store, so it must only be called when a store is active.
    const run = () => this.query(segment);
    return this.cls.isActive() ? this.tenant.runWithoutTenant(run) : run();
  }

  private async query(segment: Segment): Promise<EligibleUser[]> {
    const rows = await this.prisma.autoTradeConsent.findMany({
      where: {
        segment,
        enabled: true,
        killSwitch: false,
        user: {
          subscriptions: {
            some: {
              segment,
              status: 'ACTIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          },
          brokerCredential: { isActive: true },
        },
      },
      select: { userId: true, riskPerTrade: true, maxCapital: true },
    });
    return rows.map((r) => ({
      userId: r.userId,
      riskPerTrade: r.riskPerTrade ?? null,
      maxCapital: r.maxCapital ?? null,
    }));
  }
}
