import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  OrderRequest,
  OrderResponse,
} from '../../../common/interfaces/broker-adapter.interface';
import { SubscriptionService } from '../../subscription/subscription.service';
import { ConsentService } from '../../consent/consent.service';
import { RiskManagerService } from '../../trade-engine/services/risk-manager.service';
import { ExecuteTradeDto } from '../../trade-engine/dto/trade.dto';
import { isLiveTradingEnabled } from '../../trade-engine/live-trading';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
import type {
  AutoExecutionPort,
  ExecuteUserJob,
} from '../../signal-fanout';
import type { PublicSignal, Segment } from '../../signal-fanout';
import { AutoTradeRiskSizingService } from './auto-trade-risk-sizing.service';
import { ExecutionClaimService } from './execution-claim.service';
import { PerUserBrokerSessionFactory } from './per-user-broker-session.factory';

/**
 * The per-user auto-execution pipeline (TDA-011 §4). It is the sole
 * implementation of TDA-010's `AUTO_EXECUTION_PORT`: the `ExecuteUserWorker`
 * acquires the per-user rate token, then calls {@link execute} with one
 * sanitized `execute-user` job.
 *
 * It COMPOSES the three merged Phase-1 sub-modules (risk sizing / idempotency
 * claim / disposable per-user broker session) behind the TDA-005 decrypt seam
 * and the TDA-007/009 subscription+consent gates. The order below is
 * load-bearing (spec §4): cheap side-effect-free gates first, then per-user
 * sizing, then the shared risk backstop, then the idempotency CLAIM — which
 * runs BEFORE any decrypt or broker call so a retried/duplicate job can never
 * decrypt creds or place a second real order — then decrypt-nested-placement,
 * then settle + a coupled tamper-evident audit.
 *
 * Error classification for TDA-010's retry/DLQ routing:
 *  - every GATE + the broker's terminal REJECTED → audited `ORDER_REJECTED` and
 *    SWALLOWED (return normally; the job succeeds, no retry, no order);
 *  - a duplicate claim → success-shaped no-op (log + return);
 *  - a broker FAILED (transient fault) or a decrypt/session fault → THROWN so
 *    Bull retries with backoff and ultimately dead-letters. The claim is already
 *    held, so a retry re-hits the unique constraint and skips — at-most-once is
 *    preserved (never a duplicate real-money order).
 */
@Injectable()
export class AutoExecutionService implements AutoExecutionPort {
  private readonly logger = new Logger(AutoExecutionService.name);

  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly consent: ConsentService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
    private readonly sizing: AutoTradeRiskSizingService,
    private readonly riskManager: RiskManagerService,
    private readonly claims: ExecutionClaimService,
    @Inject(CREDENTIAL_DECRYPTOR) private readonly decryptor: CredentialDecryptor,
    private readonly brokerFactory: PerUserBrokerSessionFactory,
    private readonly audit: AuditService,
  ) {}

  async execute(job: ExecuteUserJob): Promise<void> {
    const { userId, signal, idempotencyKey } = job;
    const segment = signal.segment;

    // ---- 1. Subscription gate (authoritative re-check; §4.1) ----
    if (!(await this.subscriptions.hasActive(userId, segment))) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'NOT_SUBSCRIBED');
    }

    // ---- 2. Consent + per-user kill switch + global master switch (§4.2) ----
    if (!(await this.consent.hasAcceptedCurrent(userId))) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'CONSENT_NOT_CURRENT');
    }
    const consentRow = await this.readConsent(userId, segment);
    if (!consentRow || !consentRow.enabled) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'AUTOTRADE_OFF');
    }
    if (consentRow.killSwitch) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'USER_KILL_SWITCH');
    }
    // The platform-wide master chokepoint. Off ⇒ every gate/sizing still runs but
    // NO real order is placed for anyone. Checked early to fail fast before decrypt.
    if (!isLiveTradingEnabled()) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'LIVE_TRADING_DISABLED');
    }

    // ---- 3. Per-user risk sizing (§4.3) ----
    const sized = this.sizing.sizeOrder(
      signal,
      { riskPerTrade: consentRow.riskPerTrade ?? NaN, maxCapital: consentRow.maxCapital ?? NaN },
      optionLotSize(signal.symbol),
    );
    if ('rejected' in sized) {
      return this.rejectTerminal(
        userId, signal, idempotencyKey, `RISK_SIZE_ZERO: ${sized.reason}`,
      );
    }

    const order = buildOrder(signal, sized.quantity);

    // ---- 3b. Shared hard risk backstop (spec §7 — engine ceilings can still veto) ----
    const risk = await this.riskManager.validateTrade(toExecuteDto(order, signal));
    if (!risk.allowed) {
      return this.rejectTerminal(
        userId, signal, idempotencyKey, `RISK_BACKSTOP: ${risk.reason ?? 'blocked'}`,
      );
    }

    // ---- 4. Idempotency claim — BEFORE any decrypt/order (§4.4, load-bearing) ----
    const claim = await this.claims.claim({ idempotencyKey, userId, entryId: signal.entryId });
    if (!claim.acquired) {
      // A TDA-010 retry or a double-delivered job: someone already claimed this
      // (signal, user). Success-shaped skip — no second order, no error.
      this.logger.log(
        `Duplicate execute for key=${idempotencyKey} (user ${userId}) — already claimed, skipping`,
      );
      return;
    }

    // ---- 5 + 6. Decrypt (nested) → place order (§4.5, §4.6) ----
    // Decrypt is nested INSIDE the broker session build so plaintext creds live
    // only for the bounded lease the vault zeroizes in its finally. The order
    // carries the idempotency key as the broker `ordertag` for best-effort
    // broker-side dedupe (§5).
    let placement: OrderResponse;
    try {
      placement = await this.decryptor.withDecryptedCredentials(
        userId,
        { reason: 'ORDER', signalId: signal.entryId },
        (creds) =>
          this.brokerFactory.withSession(creds, (session) =>
            session.placeOrder(order, idempotencyKey),
          ),
      );
    } catch (err) {
      // Decrypt / ephemeral-login / infra fault. The claim is held, so a Bull
      // retry re-hits the unique constraint and skips — no double-place. Surface
      // as retryable so TDA-010 retries then dead-letters for TDA-012 reconcile.
      const msg = err instanceof Error ? err.message : String(err);
      await this.claims.markFailed(idempotencyKey, msg);
      await this.audit.append({
        action: 'ORDER_REJECTED',
        userId,
        target: signal.entryId,
        meta: { reason: 'EXECUTION_ERROR', idempotencyKey, segment },
      });
      throw err;
    }

    // ---- 7. Settle idempotency + coupled fatal audit (§4.7) ----
    if (placement.status === 'PLACED' && placement.orderId) {
      await this.claims.markPlaced(idempotencyKey, placement.orderId);
      // Fatal/transactional audit (TDA-008 §4.1): an order must never exist
      // without its audit row, so this append is left to throw (strict).
      await this.audit.append({
        action: 'ORDER_PLACED',
        userId,
        target: placement.orderId,
        meta: {
          entryId: signal.entryId,
          segment,
          quantity: sized.quantity,
          lots: sized.lots,
          idempotencyKey,
        },
      });
      this.logger.log(
        `[AUTO] Order ${placement.orderId} placed for user ${userId} (${signal.symbol} x${sized.quantity})`,
      );
      return;
    }

    if (placement.status === 'REJECTED') {
      // Terminal broker rejection (e.g. RMS margin block). Swallow + audit — a
      // retry cannot fix it, so do NOT throw.
      await this.claims.markFailed(idempotencyKey, placement.message);
      await this.audit.append({
        action: 'ORDER_REJECTED',
        userId,
        target: signal.entryId,
        meta: { reason: 'BROKER_REJECT', message: placement.message, idempotencyKey, segment },
      });
      this.logger.warn(
        `[AUTO] Order REJECTED by broker for user ${userId}: ${placement.message}`,
      );
      return;
    }

    // FAILED (broker 5xx/timeout) → transient. Audit, then throw so Bull retries.
    await this.claims.markFailed(idempotencyKey, placement.message);
    await this.audit.append({
      action: 'ORDER_REJECTED',
      userId,
      target: signal.entryId,
      meta: { reason: 'BROKER_FAULT', message: placement.message, idempotencyKey, segment },
    });
    throw new Error(`Broker order fault (retryable): ${placement.message}`);
  }

  /**
   * A pre-claim terminal rejection: audit `ORDER_REJECTED{reason}` and return
   * (swallow). No claim exists yet, so nothing to settle; no throw, so TDA-010
   * does not retry a gate that a retry cannot change.
   */
  private async rejectTerminal(
    userId: string,
    signal: PublicSignal,
    idempotencyKey: string,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `[AUTO] Rejected for user ${userId} (${signal.symbol}): ${reason}`,
    );
    await this.audit.append({
      action: 'ORDER_REJECTED',
      userId,
      target: signal.entryId,
      meta: { reason, idempotencyKey, segment: signal.segment },
    });
  }

  /**
   * Read the user's `(userId, segment)` AutoTradeConsent knobs authoritatively.
   * `AutoTradeConsent` IS a tenant model, but the queue worker has no request
   * context — mirror `FanoutEligibilityService`: bypass tenant scoping only when
   * a CLS store is actually active (Prisma is already unscoped in a raw worker).
   */
  private readConsent(userId: string, segment: Segment) {
    const run = () =>
      this.prisma.autoTradeConsent.findUnique({
        where: { userId_segment: { userId, segment } },
        select: { enabled: true, killSwitch: true, riskPerTrade: true, maxCapital: true },
      });
    return this.cls.isActive() ? this.tenant.runWithoutTenant(run) : run();
  }
}

/**
 * Option/instrument lot size — ported verbatim from the legacy
 * `AutoTradeService.getOptionLotSize` (BANKNIFTY 25 / NIFTY 50 / else 1) so
 * per-user sizing rounds to the same whole lots the manual path used.
 */
function optionLotSize(symbol: string): number {
  const upper = (symbol ?? '').toUpperCase();
  if (upper.includes('BANKNIFTY')) return 25;
  if (upper.includes('NIFTY')) return 50;
  return 1;
}

/** Build the MARKET entry order for a long anand signal from the sized quantity. */
function buildOrder(signal: PublicSignal, quantity: number): OrderRequest {
  return {
    symbol: signal.symbol,
    token: signal.token ?? '',
    exchange: 'NSE',
    side: signal.side,
    orderType: 'MARKET',
    quantity,
    positionType: signal.segment === 'SWING' ? 'CARRYFORWARD' : 'INTRADAY',
  };
}

/** Shape the order for the shared `RiskManagerService.validateTrade` backstop. */
function toExecuteDto(order: OrderRequest, signal: PublicSignal): ExecuteTradeDto {
  return {
    symbol: order.symbol,
    token: order.token,
    exchange: order.exchange,
    side: order.side,
    orderType: order.orderType,
    quantity: order.quantity,
    positionType: order.positionType,
    isPaper: false,
    source: 'AUTO',
    signalId: signal.entryId,
    strategy: `ANAND_${signal.segment}`,
  } as ExecuteTradeDto;
}
