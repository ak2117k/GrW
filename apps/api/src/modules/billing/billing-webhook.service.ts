import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import { SubscriptionService } from '../subscription/subscription.service';
import { BillingService, Seg } from './billing.service';
import {
  BillingEvent,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './providers/payment-provider.interface';

const PROVIDER = 'razorpay';

/** Result of handling one webhook delivery. */
export interface WebhookHandleResult {
  processed?: boolean;
  deduped?: boolean;
  ignored?: boolean;
  kind?: BillingEvent['kind'];
}

/**
 * The signature-verified, idempotent, entitlement-driving webhook handler
 * (TDA-015 §5). Ordering: verify -> parse -> insert-first dedupe -> map kind ->
 * `SubscriptionService.grant`/`revoke` (the ONLY entitlement writers) ->
 * persist grace -> audit (redacted) -> mark PROCESSED. An unverified or
 * duplicate event never touches entitlement; `grant`/`revoke` are idempotent
 * upserts so a crash-then-redeliver is safe (only PROCESSED short-circuits).
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly subs: SubscriptionService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(rawBody: Buffer, signature: string): Promise<WebhookHandleResult> {
    // 1. Verify the HMAC over the RAW bytes (constant-time). Reject on mismatch.
    const ok = await this.provider.verifyWebhookSignature(rawBody, signature);
    if (!ok) {
      await this.audit.append({
        action: AUDIT_ACTIONS.billing.BILLING_WEBHOOK_REJECTED,
        meta: { reason: 'SIGNATURE_MISMATCH' },
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 2. Parse the verified payload into a provider-agnostic event.
    const ev = this.provider.parseWebhookEvent(rawBody);
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    // 3. Idempotency: insert a RECEIVED row BEFORE any side effect. A duplicate
    //    (P2002) that is already PROCESSED short-circuits; a RECEIVED-but-
    //    unfinished row (prior crash) is reprocessed (steps 4-6 are idempotent).
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: PROVIDER,
          eventId: ev.eventId,
          eventType: this.eventTypeOf(ev),
          status: 'RECEIVED',
          payloadHash,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.prisma.webhookEvent.findUnique({
          where: { provider_eventId: { provider: PROVIDER, eventId: ev.eventId } },
          select: { status: true },
        });
        if (existing?.status === 'PROCESSED') {
          this.logger.debug(`Duplicate webhook ${ev.eventId} — already processed`);
          return { deduped: true };
        }
        // else fall through and reprocess the RECEIVED/FAILED row.
      } else {
        throw err;
      }
    }

    await this.audit.append({
      action: AUDIT_ACTIONS.billing.BILLING_WEBHOOK_RECEIVED,
      meta: { eventId: ev.eventId, kind: ev.kind, payloadHash },
    });

    // 4/5. Map kind -> entitlement + persist grace. Resolve the (user, segment)
    //      the provider subscription id maps to.
    const result = await this.applyEvent(ev);

    // 7. Mark PROCESSED (only PROCESSED short-circuits future redeliveries).
    await this.prisma.webhookEvent.update({
      where: { provider_eventId: { provider: PROVIDER, eventId: ev.eventId } },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    return result;
  }

  /** Map a verified event onto grant/revoke + grace, driving SubscriptionService. */
  private async applyEvent(ev: BillingEvent): Promise<WebhookHandleResult> {
    if (ev.kind === 'UNHANDLED') {
      return { processed: true, kind: ev.kind, ignored: true };
    }
    if (!ev.providerSubId) {
      this.logger.warn(`Webhook ${ev.eventId} (${ev.kind}) has no providerSubId`);
      return { processed: true, kind: ev.kind, ignored: true };
    }

    const target = await this.billing.resolveByProviderSubId(ev.providerSubId);
    if (!target) {
      this.logger.warn(
        `Webhook ${ev.eventId} references unknown providerSubId ${ev.providerSubId}`,
      );
      return { processed: true, kind: ev.kind, ignored: true };
    }
    const { userId, segment } = target;

    switch (ev.kind) {
      case 'SUBSCRIPTION_ACTIVATED':
      case 'PAYMENT_CHARGED':
        await this.grantAccess(userId, segment, ev);
        await this.auditBilling(
          ev.kind === 'PAYMENT_CHARGED'
            ? AUDIT_ACTIONS.billing.BILLING_PAYMENT_CHARGED
            : AUDIT_ACTIONS.billing.BILLING_SUBSCRIPTION_ACTIVATED,
          userId,
          segment,
          ev,
        );
        break;

      case 'PAYMENT_PENDING':
      case 'PAYMENT_FAILED':
        // Dunning: keep ACTIVE until expiresAt, record the grace window. No revoke.
        await this.billing.setGraceUntil(
          userId,
          segment,
          new Date(Date.now() + this.billing.graceMs()),
        );
        await this.auditBilling(
          AUDIT_ACTIONS.billing.BILLING_PAYMENT_FAILED,
          userId,
          segment,
          ev,
        );
        break;

      case 'SUBSCRIPTION_HALTED':
      case 'SUBSCRIPTION_CANCELLED':
      case 'SUBSCRIPTION_COMPLETED':
        await this.subs.revoke(userId, segment);
        await this.auditBilling(this.revokeAction(ev.kind), userId, segment, ev);
        await this.auditBilling(
          AUDIT_ACTIONS.billing.BILLING_ACCESS_REVOKED_LAPSE,
          userId,
          segment,
          ev,
        );
        break;
    }

    return { processed: true, kind: ev.kind };
  }

  /** Grant access rolling expiresAt to currentPeriodEnd + grace; clear grace. */
  private async grantAccess(userId: string, segment: Seg, ev: BillingEvent): Promise<void> {
    const periodEnd = ev.currentPeriodEnd ?? new Date();
    const expiresAt = new Date(periodEnd.getTime() + this.billing.graceMs());
    await this.subs.grant(userId, segment, expiresAt);
    await this.billing.setGraceUntil(userId, segment, null);
  }

  private revokeAction(kind: BillingEvent['kind']): string {
    switch (kind) {
      case 'SUBSCRIPTION_HALTED':
        return AUDIT_ACTIONS.billing.BILLING_SUBSCRIPTION_HALTED;
      case 'SUBSCRIPTION_CANCELLED':
        return AUDIT_ACTIONS.billing.BILLING_SUBSCRIPTION_CANCELLED;
      default:
        return AUDIT_ACTIONS.billing.BILLING_SUBSCRIPTION_COMPLETED;
    }
  }

  /** Append a billing audit event with REDACTED meta (never secret/sig/PII). */
  private auditBilling(
    action: string,
    userId: string,
    segment: Seg,
    ev: BillingEvent,
  ): Promise<unknown> {
    return this.audit.append({
      action: action as never,
      userId,
      target: ev.providerSubId ?? null,
      meta: {
        eventId: ev.eventId,
        segment,
        kind: ev.kind,
        currentPeriodEnd: ev.currentPeriodEnd?.toISOString() ?? null,
      },
    });
  }

  private eventTypeOf(ev: BillingEvent): string {
    const raw = ev.raw as { event?: string } | undefined;
    return raw?.event ?? ev.kind;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
