import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditService } from '../../../common/audit/audit.service';
import { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
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
import {
  PerUserBrokerSessionFactory,
  type ClassifiedPlacement,
  type UserBrokerSession,
} from './per-user-broker-session.factory';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import { findOrderByTag } from '../../sentinel-executor/domain/exit-order';
import { coreEntryAllowed, CoreKillSwitchEntryBlockedError } from '../../trade-core/risk-wall/kill-gate';

/** DI seam for the pause before an order-book lookup (tests inject an instant one). */
export const AUTO_EXEC_SLEEP = Symbol('AUTO_EXEC_SLEEP');
export type AutoExecSleep = (ms: number) => Promise<void>;
const defaultSleep: AutoExecSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Grace before looking for an order whose placement answer was not definitive. */
const TAG_LOOKUP_DELAY_MS = 2_000;

/**
 * The Angel `ordertag` for one (signal, user) execution. Angel documents the tag
 * as at most 20 alphanumeric characters, so the 64-char sha256 idempotency key is
 * NOT sent raw: `ae` + its first 18 alphanumerics. Stable across retries (the key
 * is), and never starts with the ai-exit executor's `ax` prefix. The DB claim,
 * not the tag, is the idempotency anchor; the tag is how an UNCERTAIN placement
 * is found again in the order book.
 */
export function autoExecOrderTag(idempotencyKey: string): string {
  return `ae${String(idempotencyKey).replace(/[^A-Za-z0-9]/g, '').slice(0, 18)}`;
}

/** What happened inside the broker session, settled after the lease closes. */
type Settlement =
  | { kind: 'PLACED'; orderId: string; message: string; reconciled: boolean; bookStatus?: string }
  | { kind: 'REJECTED'; message: string; bookStatus?: string }
  | { kind: 'UNCERTAIN'; message: string; detail: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
 *  - every GATE + Angel's own definitive REJECTED → audited `ORDER_REJECTED` and
 *    SWALLOWED (return normally; the job succeeds, no retry, no order);
 *  - a duplicate claim → success-shaped no-op (log + return);
 *  - a placement with no definitive answer (the SDK resolves a timeout/network
 *    error to `{}` and an HTTP error to `{status,message}`, so the order MAY
 *    exist) is reconciled from the order book by our ordertag: found live →
 *    PLACED + `ORDER_PLACED`; found rejected/cancelled → `ORDER_REJECTED`; not
 *    found, or the book did not answer → terminal `ORDER_UNCERTAIN` (claim +
 *    audit), swallowed and NEVER retried — someone must check the broker;
 *  - a decrypt/session fault before the order was sent → THROWN so Bull
 *    retries with backoff and ultimately dead-letters. The claim is already
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
    @Optional() @Inject(AUTO_EXEC_SLEEP) sleep?: AutoExecSleep,
  ) {
    this.sleep = sleep ?? defaultSleep;
  }

  private readonly sleep: AutoExecSleep;

  async execute(job: ExecuteUserJob): Promise<void> {
    const { userId, signal, idempotencyKey } = job;
    // SP2 M2 (owner answer 2): this user's core kill switch blocks new auto entries (fails closed).
    if (!(await coreEntryAllowed('auto-execution', { userId, ref: signal.symbol }))) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'USER_KILL_SWITCH');
    }
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
    // carries a short tag derived from the idempotency key as the broker
    // `ordertag` (§5): the only handle to find it again when the placement
    // answer is not definitive.
    const orderTag = autoExecOrderTag(idempotencyKey);
    let sent = false;
    let settled: Settlement;
    try {
      settled = await this.decryptor.withDecryptedCredentials(
        userId,
        { reason: 'ORDER', signalId: signal.entryId },
        (creds) =>
          this.brokerFactory.withSession(creds, async (session) => {
            // Re-check this user's core kill switch: the gate at the top ran before the
            // gates, the claim and the decrypt + broker login, and an engage in that
            // window must still stop the order. Checked inside the session, last thing
            // before the broker call.
            if (!(await coreEntryAllowed('auto-execution', { userId, ref: signal.symbol, recheck: true }))) {
              throw new CoreKillSwitchEntryBlockedError('auto-execution', signal.symbol);
            }
            sent = true;
            let placement: ClassifiedPlacement;
            try {
              placement = await session.placeOrderClassified(order, orderTag);
            } catch (err) {
              placement = { status: 'UNCERTAIN', orderId: '', message: errText(err) };
            }
            return this.settleInSession(session, placement, orderTag);
          }),
      );
    } catch (err) {
      if (err instanceof CoreKillSwitchEntryBlockedError) {
        // Refused late: no order exists. Settle the claim and record the same terminal
        // USER_KILL_SWITCH reject as the early refusal; no throw, so Bull does not retry.
        await this.claims.markFailed(idempotencyKey, 'USER_KILL_SWITCH');
        return this.rejectTerminal(userId, signal, idempotencyKey, 'USER_KILL_SWITCH');
      }
      const msg = errText(err);
      if (sent) {
        // The order was handed to the broker; a later fault (lease teardown etc.)
        // says nothing about whether it exists. Never retried.
        return this.settleUncertain(userId, signal, idempotencyKey, orderTag, {
          kind: 'UNCERTAIN', message: msg, detail: 'FAULT_AFTER_SEND',
        });
      }
      // Decrypt / ephemeral-login / infra fault BEFORE any order was sent. The
      // claim is held, so a Bull retry re-hits the unique constraint and skips —
      // no double-place. Surface as retryable so TDA-010 retries then dead-letters
      // for TDA-012 reconcile.
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
    if (settled.kind === 'PLACED') {
      await this.claims.markPlaced(idempotencyKey, settled.orderId);
      // Fatal/transactional audit (TDA-008 §4.1): an order must never exist
      // without its audit row, so this append is left to throw (strict).
      await this.audit.append({
        action: 'ORDER_PLACED',
        userId,
        target: settled.orderId,
        meta: {
          entryId: signal.entryId,
          segment,
          quantity: sized.quantity,
          lots: sized.lots,
          idempotencyKey,
          orderTag,
          ...(settled.reconciled
            ? { reconciled: true, placementMessage: settled.message, bookStatus: settled.bookStatus ?? null }
            : {}),
        },
      });
      this.logger.log(
        `[AUTO] Order ${settled.orderId} placed for user ${userId} (${signal.symbol} x${sized.quantity})` +
          (settled.reconciled ? ` — found by ordertag after a non-definitive answer: ${settled.message}` : ''),
      );
      return;
    }

    if (settled.kind === 'REJECTED') {
      // Terminal broker rejection (Angel's own answer, or our tag rejected/
      // cancelled in its order book). A retry cannot fix it, so do NOT throw.
      await this.claims.markFailed(idempotencyKey, settled.message);
      await this.audit.append({
        action: 'ORDER_REJECTED',
        userId,
        target: signal.entryId,
        meta: {
          reason: 'BROKER_REJECT',
          message: settled.message,
          idempotencyKey,
          segment,
          ...(settled.bookStatus ? { bookStatus: settled.bookStatus, orderTag } : {}),
        },
      });
      this.logger.warn(
        `[AUTO] Order REJECTED by broker for user ${userId}: ${settled.message}`,
      );
      return;
    }

    return this.settleUncertain(userId, signal, idempotencyKey, orderTag, settled);
  }

  /**
   * Turn a classified placement into a settlement while the session is still
   * open. Only a non-definitive answer touches the order book: after a short
   * grace, our own ordertag decides. Never re-sends.
   */
  private async settleInSession(
    session: UserBrokerSession,
    placement: ClassifiedPlacement,
    orderTag: string,
  ): Promise<Settlement> {
    if (placement.status === 'PLACED') {
      return { kind: 'PLACED', orderId: placement.orderId, message: placement.message, reconciled: false };
    }
    if (placement.status === 'REJECTED') {
      return { kind: 'REJECTED', message: placement.message };
    }
    await this.sleep(TAG_LOOKUP_DELAY_MS);
    let book: unknown[] | null;
    try {
      book = answeredPositions(await session.getOrderBookEnvelope());
    } catch (err) {
      this.logger.warn(`[AUTO] order-book read failed after an uncertain placement: ${errText(err)}`);
      book = null;
    }
    if (book === null) {
      return { kind: 'UNCERTAIN', message: placement.message, detail: 'ORDER_BOOK_NOT_ANSWERED' };
    }
    const mine = findOrderByTag(book, orderTag);
    if (!mine) {
      return { kind: 'UNCERTAIN', message: placement.message, detail: 'TAG_NOT_IN_ORDER_BOOK' };
    }
    if (mine.status === 'rejected' || mine.status === 'cancelled') {
      return { kind: 'REJECTED', message: mine.text || placement.message, bookStatus: mine.status };
    }
    return {
      kind: 'PLACED',
      orderId: mine.orderId || `tag:${orderTag}`,
      message: placement.message,
      reconciled: true,
      bookStatus: mine.status || undefined,
    };
  }

  /**
   * The order's fate is unknown: it may be live at the broker. Terminal and
   * visible — the claim is settled ORDER_UNCERTAIN and an `ORDER_UNCERTAIN`
   * audit is written; no throw, so Bull never retries (and the held claim would
   * skip a retry anyway). Never audited as a rejection.
   */
  private async settleUncertain(
    userId: string,
    signal: PublicSignal,
    idempotencyKey: string,
    orderTag: string,
    s: Extract<Settlement, { kind: 'UNCERTAIN' }>,
  ): Promise<void> {
    await this.claims.markUncertain(idempotencyKey, `${s.detail}: ${s.message}`);
    await this.audit.append({
      action: 'ORDER_UNCERTAIN',
      userId,
      target: signal.entryId,
      meta: {
        reason: s.detail,
        message: s.message,
        idempotencyKey,
        orderTag,
        segment: signal.segment,
        symbol: signal.symbol,
      },
    });
    this.logger.error(
      `[AUTO] ORDER_UNCERTAIN for user ${userId} (${signal.symbol}, ordertag ${orderTag}): ` +
        `${s.detail} — ${s.message}. The order may exist at the broker; check it manually. Not retried.`,
    );
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
    // Pass the signal entry price so the shared RiskManager's per-trade capital
    // ceiling (orderValue = price * qty) can actually veto an oversized auto
    // order. Without a price it reads 0 and the ceiling is silently inert.
    price: signal.entryPrice,
    positionType: order.positionType,
    isPaper: false,
    source: 'AUTO',
    signalId: signal.entryId,
    strategy: `ANAND_${signal.segment}`,
  } as ExecuteTradeDto;
}
