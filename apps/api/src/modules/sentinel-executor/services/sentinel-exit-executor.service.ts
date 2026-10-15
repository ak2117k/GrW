// apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
import type {
  ClassifiedCancel,
  ClassifiedPlacement,
  UserBrokerSession,
} from '../../auto-execution/services/per-user-broker-session.factory';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import type { SessionClock } from '../../market-hub/session-clock';
import { UNKNOWN_FATE_REASONS, type AiExitStatus, type AutoExitConfig } from '../domain/auto-exit.types';
import {
  protectiveCancelState,
  protectiveOrdersFor,
  type ProtectiveOrder,
  aiExitOrderTag,
  findOrderByTag,
  hasOpenOrderFor,
  hasPriorAiExit,
  isFlat,
  isMarketRefusal,
  isTerminalOrderStatus,
  istDayStartUtc,
  limitFallbackPrice,
  planExitOrder,
  tickRupees,
} from '../domain/exit-order';
import {
  CANCEL_CONFIRM_STEPS_MS,
  READ_RETRY_BACKOFF_MS,
  READ_RETRY_WINDOW_MS,
  TAG_LOOKUP_DELAY_MS,
} from '../domain/claim-timing';
import { findOrderFill, type OrderFill } from '../domain/exit-fill';
import { evaluateGuards } from '../domain/guards';
import type { ExitTrigger } from '../domain/manual-exit';
import {
  AiExitExecutionRepository,
  type AiExitPatch,
  type PendingVerdict,
} from '../repositories/ai-exit-execution.repository';
import { FeedSessionNotReadyError, NoFeedSessionError, OwnerBrokerSessionProvider } from './owner-broker-session.provider';

export const AI_EXIT_SESSION_CLOCK = Symbol('AI_EXIT_SESSION_CLOCK');
export const AI_EXIT_SLEEP = Symbol('AI_EXIT_SLEEP');
export type Sleep = (ms: number) => Promise<void>;
export type AiExitOutcome = { status: AiExitStatus | 'DUPLICATE'; reason?: string };

/** Plan R10: order-book checks at +2 s, +5 s, +10 s after placing. */
const CONFIRM_STEPS_MS = [2_000, 3_000, 5_000];
/** Reason prefix for every outcome that leaves a position whose protective order we cancelled unexited. */
export const UNPROTECTED_AFTER_CANCEL = 'UNPROTECTED_AFTER_CANCEL';

type Tracker = { id: string; userId: string; status: string; kind: string; exchange: string; token: string; qty: number };
type Inst = { tickSize: number | null; lotSize: number | null } | null;
type PreCheck =
  | { kind: 'ok'; order: OrderRequest; ltp: number; unitVerified: boolean }
  | { kind: 'protective'; order: OrderRequest; ltp: number; unitVerified: boolean; orders: ProtectiveOrder[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string; detail?: string };
type OkCheck = Extract<PreCheck, { kind: 'ok' }>;

/**
 * Per-verdict state threaded through the flow. `sent` flips the moment placeOrder
 * is invoked; `cancelSent` the moment a cancel of a protective order is invoked.
 */
interface Run {
  id: string;
  v: PendingVerdict;
  cfg: AutoExitConfig;
  inst: Inst;
  sent: boolean;
  /** E5: wall clock immediately before the (last) placeOrder call; null until one is sent. */
  sentAt: Date | null;
  cancelSent: boolean;
  trigger: ExitTrigger;
  /** The `now` the guards judged the verdict's age against. */
  now: Date;
  /** Wall clock (Date.now) when the attempt started: read retries are budgeted from here. */
  startedMs: number;
}

/** One broker read: its rows, or null when not answered after `attempts` tries (`detail` says why). */
type ReadResult = { rows: unknown[] | null; attempts: number; detail: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/**
 * Why an envelope is not an answer, from the broker's own status / errorcode /
 * message only (never the request, credentials or tokens). SDK shapes: `{}` on a
 * network error or its 7 s timeout, `{status:<http>,message}` on an HTTP error,
 * `{status:false,message,errorcode}` on an Angel refusal.
 */
function unansweredDetail(envelope: unknown): string {
  if (envelope == null) return 'no answer (empty)';
  if (Array.isArray(envelope)) return 'no answer (empty array)';
  if (typeof envelope !== 'object') return 'no answer (unexpected shape)';
  const e = envelope as Record<string, unknown>;
  const parts: string[] = [];
  if (e.status !== undefined) parts.push(`status ${String(e.status)}`);
  const code = e.errorcode ?? e.errorCode;
  if (code != null && code !== '') parts.push(`errorcode ${String(code)}`);
  if (typeof e.message === 'string' && e.message) parts.push(`"${e.message}"`);
  if (e.status === true || e.success === true) parts.push('unreadable data');
  return (parts.length > 0 ? parts.join(' ') : 'no answer (empty)').slice(0, 200);
}
/** A non-ok check's reason. `protective` only comes back from a check that may cancel; elsewhere it is an open order. */
const refusal = (pre: Exclude<PreCheck, { kind: 'ok' }>) => (pre.kind === 'protective' ? 'OPEN_ORDER_EXISTS' : pre.reason);
/** "SL1 (STOPLOSS_MARKET SELL 100), T1 (LIMIT SELL 100)" */
const describeProtective = (orders: ProtectiveOrder[]) =>
  orders.map((o) => `${o.orderId} (${o.orderType} ${o.side} ${o.quantity})`).join(', ');

/**
 * Spec §5 for ONE verdict. Never throws (except when the database itself fails,
 * which leaves the row CLAIMED for the R8 sweep): every path ends in exactly one
 * terminal row status and one `[ai-exit]` log line. Claim first, broker second.
 *
 * The core kill switch is deliberately NOT consulted (CLAUDE.md §9: exits are
 * never blocked).
 */
@Injectable()
export class SentinelExitExecutor {
  private readonly logger = new Logger(SentinelExitExecutor.name);
  private readonly capWarned = new Set<string>();

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly prisma: PrismaService,
    private readonly sessions: OwnerBrokerSessionProvider,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
    @Inject(AI_EXIT_SLEEP) private readonly sleep: Sleep,
  ) {}

  async process(v: PendingVerdict, cfg: AutoExitConfig, now: Date = new Date()): Promise<AiExitOutcome> {
    // 1. CLAIM — the idempotency anchor. Nothing touches the broker before this.
    const id = await this.repo.claim(v, cfg.mode);
    if (!id) return { status: 'DUPLICATE' };
    return this.execute(id, v, cfg, now, 'AI');
  }

  /**
   * Steps 2–7 for an attempt whose row `id` the caller has ALREADY claimed.
   * 'MANUAL' (the owner's "Exit now", ManualExitService): always live whatever
   * AI_AUTO_EXIT_MODE says (still refused when the exchange's qty unit is not
   * configured), the AI switch/allow-list/age/cap guards do not apply, every
   * position and order-book guard does, and the ordertag prefix is 'am'.
   */
  async execute(
    id: string, v: PendingVerdict, aiCfg: AutoExitConfig, now: Date = new Date(), trigger: ExitTrigger = 'AI',
  ): Promise<AiExitOutcome> {
    const cfg: AutoExitConfig = trigger === 'MANUAL' ? { ...aiCfg, mode: 'live' } : aiCfg;

    // 2. GUARDS — DB + clock only.
    const tracker = (await this.prisma.tradeTracker.findUnique({ where: { id: v.trackerId } })) as Tracker | null;
    const [countedToday, inFlight] = await Promise.all([
      trigger === 'MANUAL' ? Promise.resolve(0) : this.repo.countCountedSince(v.userId, istDayStartUtc(now), cfg.mode),
      this.repo.hasInFlight(v.trackerId, id, now, tracker
        ? { userId: v.userId, exchange: String(tracker.exchange ?? '').toUpperCase(), token: String(tracker.token ?? '') }
        : undefined),
    ]);
    const g = evaluateGuards({
      config: cfg, now, verdict: v, tracker, countedToday, inFlight, trigger,
      isOpen: (ex, at) => this.clock.isOpen(ex, at),
    });
    if (!g.ok) {
      if (g.reason === 'DAILY_CAP') this.warnCapOnce(v.userId, now);
      return this.finish(id, v, 'SKIPPED', g.reason);
    }
    const t = tracker as Tracker;

    // Instrument tick + lot size (R5, R16), read once, outside the broker lease.
    let inst: Inst;
    try {
      inst = (await this.prisma.instrument.findFirst({
        where: { exchange: t.exchange, token: t.token },
        select: { tickSize: true, lotSize: true },
      })) as Inst;
    } catch (err) {
      return this.finish(id, v, 'FAILED', 'INSTRUMENT_READ', { brokerMessage: errText(err) });
    }

    const run: Run = { id, v, cfg, inst, sent: false, sentAt: null, cancelSent: false, trigger, now, startedMs: Date.now() };

    // 3–7. BROKER — one session lease, tier chosen once (ruling R1).
    let outcome: AiExitOutcome;
    try {
      outcome = await this.sessions.withOwnerSession(v.userId, async (s, source) => {
        await this.repo.update(id, { sessionSource: source });
        const first = await this.preOrderCheck(s, t, run, true);
        if (first.kind === 'skip' || first.kind === 'fail') {
          return first.kind === 'skip'
            ? this.finish(id, v, 'SKIPPED', first.reason)
            : this.finish(id, v, 'FAILED', first.reason, first.detail ? { brokerMessage: first.detail } : {});
        }
        await this.recordPlan(id, first.order, first.ltp);

        if (cfg.mode === 'dry-run') {
          const sell = `${first.order.side} ${first.order.quantity} ${first.order.symbol} (${first.order.positionType}) at MARKET`;
          const what = first.kind === 'protective'
            ? `would cancel protective ${describeProtective(first.orders)} then ${sell}`
            : `would ${sell}`;
          // R16: the table has no flag column, so an unverified unit is stated in the reason.
          const reason = first.unitVerified ? what : `UNIT_UNVERIFIED: ${what}`;
          this.logger.log(`[ai-exit] DRY-RUN ${reason} — verdict ${v.id}: ${v.reason}`);
          await this.repo.update(id, { status: 'DRY_RUN', reason });
          return { status: 'DRY_RUN', reason };
        }
        // Belt and braces: planExitOrder never returns an unverified plan in live mode.
        // Checked BEFORE any cancel, so an unconfigured unit never strips a stop-loss.
        if (!first.unitVerified) return this.finish(id, v, 'SKIPPED', `QTY_UNIT_UNCONFIGURED:${first.order.exchange}`);

        let pre: OkCheck;
        if (first.kind === 'protective') {
          const c = await this.cancelProtective(s, t, run, first.orders);
          if (c.kind === 'stop') return c.outcome;
          pre = c.pre;
          await this.recordPlan(id, pre.order, pre.ltp);
        } else {
          pre = first;
        }
        const o = pre.order;

        const r = await this.place(s, run, o, 'M');
        this.logger.log(`[ai-exit] LIVE MARKET ${o.side} ${o.quantity} ${o.symbol} → ${r.status} ${r.orderId || ''} (${r.message}) — verdict ${v.id}`);
        if (r.status === 'PLACED' && r.orderId) {
          await this.repo.update(id, { status: 'PLACED', brokerOrderId: r.orderId, brokerMessage: r.message, orderSentAt: run.sentAt ?? undefined });
          return this.confirm(s, run, o, r.orderId, 'M');
        }
        return this.settleUnplaced(s, run, o, r, 'M');
      }, { allowEphemeralLogin: cfg.mode === 'live' });
    } catch (err) {
      if (err instanceof FeedSessionNotReadyError) {
        // Owner decision: refuse rather than a second Angel login over the live feed.
        return this.finish(id, v, 'SKIPPED', 'FEED_SESSION_NOT_READY', { brokerMessage: err.message }, true);
      }
      if (err instanceof NoFeedSessionError) {
        // Review fix 3: dry-run never logs in to Angel; it rehearses on the warm feed only.
        return this.finish(id, v, 'SKIPPED', 'NO_FEED_SESSION', { brokerMessage: err.message });
      }
      // Once an order has been sent, any later fault means its fate is unknown.
      outcome = await this.finish(id, v, 'FAILED', run.sent ? 'ORDER_UNCERTAIN' : 'SESSION', { brokerMessage: errText(err) });
    }
    return this.flagUnprotected(run, outcome);
  }

  /** The planned order, with the positions LTP the pre-check saw (E5 `orderLtp`). */
  private recordPlan(id: string, o: OrderRequest, ltp: number): Promise<void> {
    return this.repo.update(id, {
      exchange: o.exchange, token: o.token, side: o.side, quantity: o.quantity,
      productType: o.positionType, orderType: 'MARKET',
      ...(Number.isFinite(ltp) && ltp > 0 ? { orderLtp: ltp } : {}),
    });
  }

  /** The ONLY call site of placeOrder. Marks the run as sent before the call. */
  private place(s: UserBrokerSession, run: Run, o: OrderRequest, leg: 'M' | 'L'): Promise<ClassifiedPlacement> {
    run.sent = true;
    run.sentAt = new Date();
    return s.placeOrderClassified(o, aiExitOrderTag(run.v.id, leg, run.trigger));
  }

  /** The ONLY call site of cancelOrder. Marks the run as cancel-sent before the call. */
  private cancel(s: UserBrokerSession, run: Run, p: ProtectiveOrder): Promise<ClassifiedCancel> {
    run.cancelSent = true;
    return s.cancelOrderClassified(p.variety, p.orderId);
  }

  /**
   * Cancel protective then exit (AI_AUTO_EXIT_CANCEL_PROTECTIVE, 2026-10-13).
   * 1. Intent on the row (reason CANCELLING_PROTECTIVE:<ids>, brokerMessage keeps
   *    the ids even if the R8 sweep later overwrites the reason) BEFORE any cancel.
   * 2. Cancel each order; the cancel ANSWER is never trusted — the order book is
   *    re-read (+1 s, +3 s, +6 s) until every order is terminal. Still open or
   *    unknown (book unanswered) ⇒ FAILED: CANCEL_UNCERTAIN, no exit is sent.
   * 3. Fresh positions + order book (no second cancel): flat ⇒ SKIPPED
   *    PROTECTIVE_FILLED (or ALREADY_FLAT); anything else refusing ⇒ FAILED
   *    UNPROTECTED_AFTER_CANCEL:<reason>; ok ⇒ the normal exit of the FRESH |netqty|.
   */
  private async cancelProtective(
    s: UserBrokerSession, t: Tracker, run: Run, orders: ProtectiveOrder[],
  ): Promise<{ kind: 'stop'; outcome: AiExitOutcome } | { kind: 'ok'; pre: OkCheck }> {
    const { id, v } = run;
    const ids = orders.map((o) => o.orderId);
    const what = describeProtective(orders);
    await this.repo.update(id, {
      reason: `CANCELLING_PROTECTIVE:${ids.join(',')}`,
      brokerMessage: `cancelling protective ${what} before the exit`,
    });
    this.logger.warn(`[ai-exit] cancelling protective ${what} on ${v.symbol} before the exit — verdict ${v.id}`);

    const answers: string[] = [];
    for (const p of orders) {
      const r = await this.cancel(s, run, p);
      answers.push(`${p.orderId}: ${r.status} (${r.message})`);
      this.logger.log(`[ai-exit] cancel ${p.orderId} → ${r.status} (${r.message}) — verdict ${v.id}`);
    }

    let state: { open: string[]; filled: string[] } | null = null;
    for (const step of CANCEL_CONFIRM_STEPS_MS) {
      await this.sleep(step);
      const { rows: book } = await this.readRows(run, 'order book', () => s.getOrderBookEnvelope());
      if (book) state = protectiveCancelState(book, ids);
      if (state && state.open.length === 0) break;
    }
    if (!state || state.open.length > 0) {
      const still = state ? state.open.join(',') : ids.join(',');
      this.logger.warn(
        `[ai-exit] !!! CANCEL_UNCERTAIN on ${v.symbol}: protective order(s) ${still} not confirmed cancelled — ` +
          `NO exit was sent. The position may be partly unprotected AND unexited: check Angel now. Cancel answers: ${answers.join('; ')}`,
      );
      return { kind: 'stop', outcome: await this.finish(id, v, 'FAILED', 'CANCEL_UNCERTAIN', {
        brokerMessage: `still open/unknown: ${still}; ${answers.join('; ')}`.slice(0, 500),
      }) };
    }

    const pre = await this.preOrderCheck(s, t, run, false);
    if (pre.kind === 'skip' && pre.reason === 'ALREADY_FLAT') {
      const reason = state.filled.length > 0 ? 'PROTECTIVE_FILLED' : 'ALREADY_FLAT';
      return { kind: 'stop', outcome: await this.finish(id, v, 'SKIPPED', reason, {
        brokerMessage: state.filled.length > 0 ? `protective order(s) ${state.filled.join(',')} filled` : undefined,
      }) };
    }
    if (pre.kind !== 'ok') {
      return { kind: 'stop', outcome: await this.finish(id, v, 'FAILED', `${UNPROTECTED_AFTER_CANCEL}:${refusal(pre)}`) };
    }
    return { kind: 'ok', pre };
  }

  /**
   * After a protective order was cancelled, a REJECTED or FAILED exit leaves the
   * position unprotected: say so in the reason (UNPROTECTED_AFTER_CANCEL:<reason>)
   * and WARN loudly. Unknown-fate reasons (ORDER_UNCERTAIN, INTERRUPTED) keep their
   * exact text — the in-flight guard and the cap match on it — and only warn.
   * v1 never re-places the stop-loss automatically.
   */
  private async flagUnprotected(run: Run, outcome: AiExitOutcome): Promise<AiExitOutcome> {
    if (!run.cancelSent || (outcome.status !== 'REJECTED' && outcome.status !== 'FAILED')) return outcome;
    if (outcome.reason === 'CANCEL_UNCERTAIN') return outcome; // already warned, no exit was sent
    const reason = outcome.reason ?? '';
    const alarm = `[ai-exit] !!! ${run.v.symbol}: the protective stop-loss was cancelled and the exit ended ${outcome.status}` +
      `${reason ? `: ${reason}` : ''} — the position may be UNPROTECTED. Re-place a stop-loss or exit at Angel now. verdict ${run.v.id}`;
    this.logger.warn(alarm);
    if (reason.startsWith(UNPROTECTED_AFTER_CANCEL) || UNKNOWN_FATE_REASONS.includes(reason)) {
      return outcome;
    }
    const flagged = `${UNPROTECTED_AFTER_CANCEL}:${reason || outcome.status}`;
    await this.repo.update(run.id, { status: outcome.status, reason: flagged });
    return { status: outcome.status, reason: flagged };
  }

  /**
   * Review fix 1. A placement that did not come back PLACED-with-an-id is settled
   * from the ORDER BOOK, by our own ordertag, never from the SDK's answer alone:
   * the SDK resolves network errors/timeouts to `{}` and HTTP errors to
   * `{status:<http>}`, so the order may exist.
   *  - book not answered                      → FAILED: ORDER_UNCERTAIN
   *  - our tag live/complete in the book      → PLACED (then the R10 confirm)
   *  - our tag rejected/cancelled in the book → REJECTED (MARKET refusal → the one fallback)
   *  - no row with our tag + Angel's definitive REJECTED → REJECTED (MARKET refusal → fallback)
   *  - no row with our tag otherwise          → FAILED: ORDER_UNCERTAIN
   * Never re-sent.
   */
  private async settleUnplaced(
    s: UserBrokerSession, run: Run, o: OrderRequest, r: ClassifiedPlacement, leg: 'M' | 'L',
  ): Promise<AiExitOutcome> {
    const { id, v } = run;
    const sentAt = { orderSentAt: run.sentAt ?? undefined };
    const definitive = r.status === 'REJECTED';
    if (!definitive) await this.sleep(TAG_LOOKUP_DELAY_MS);
    // A read retry here is safe: it only looks for our tag; nothing is ever re-sent.
    const { rows: book } = await this.readRows(run, 'order book', () => s.getOrderBookEnvelope());
    if (book === null) return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message, ...sentAt });
    const mine = findOrderByTag(book, aiExitOrderTag(v.id, leg, run.trigger));

    if (mine && mine.status !== 'rejected' && mine.status !== 'cancelled') {
      this.logger.warn(`[ai-exit] ${o.symbol} placement answer was "${r.message}" but order ${mine.orderId || '?'} (${mine.status || 'unknown'}) carries our tag — treating as PLACED`);
      await this.repo.update(id, {
        status: 'PLACED', brokerOrderId: mine.orderId || null, brokerMessage: r.message, orderStatus: mine.status || null,
        orderSentAt: run.sentAt ?? undefined,
      });
      return mine.orderId ? this.confirm(s, run, o, mine.orderId, leg) : { status: 'PLACED' };
    }
    if (mine) {
      const text = mine.text || r.message;
      if (mine.status === 'rejected' && leg === 'M' && isMarketRefusal(text)) {
        await this.repo.update(id, { orderStatus: 'rejected', brokerMessage: text });
        return this.fallback(s, run, o, mine.orderId || null);
      }
      return this.finish(id, v, 'REJECTED', mine.status === 'cancelled' ? 'CANCELLED' : 'BROKER_REJECTED', {
        orderStatus: mine.status, brokerMessage: text, ...sentAt,
      });
    }
    if (definitive) {
      if (leg === 'M' && isMarketRefusal(r.message)) {
        await this.repo.update(id, { brokerMessage: r.message });
        return this.fallback(s, run, o, null);
      }
      return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { brokerMessage: r.message, ...sentAt });
    }
    return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message, ...sentAt });
  }

  /** A broker read whose throw (timeout, disposed) is treated as "not answered". Never retried (R10 confirm polls). */
  private async rows(read: () => Promise<unknown>): Promise<unknown[] | null> {
    try {
      return answeredPositions(await read());
    } catch (err) {
      this.logger.warn(`[ai-exit] broker read failed: ${errText(err)}`);
      return null;
    }
  }

  /**
   * A broker read while the row is CLAIMED. Only an answered envelope
   * (status === true) is an answer; anything else, or a throw, is retried after
   * READ_RETRY_BACKOFF_MS while {@link mayRetryRead} allows. Reads are side-effect
   * free: this never sends, cancels or re-sends anything.
   */
  private async readRows(run: Run, what: 'positions' | 'order book', read: () => Promise<unknown>): Promise<ReadResult> {
    for (let attempt = 1; ; attempt++) {
      let detail: string;
      try {
        const envelope = await read();
        const rows = answeredPositions(envelope);
        if (rows) return { rows, attempts: attempt, detail: '' };
        detail = unansweredDetail(envelope);
      } catch (err) {
        detail = `threw: ${errText(err)}`.slice(0, 200);
      }
      const wait = READ_RETRY_BACKOFF_MS[attempt - 1];
      if (wait === undefined || !this.mayRetryRead(run, wait)) {
        const why = `${what} read not answered (attempts=${attempt}): ${detail}`;
        this.logger.warn(`[ai-exit] ${why} — giving up — ${run.v.symbol} verdict ${run.v.id}`);
        return { rows: null, attempts: attempt, detail: why };
      }
      this.logger.warn(
        `[ai-exit] ${what} read not answered (attempt ${attempt}): ${detail} — retrying in ${wait} ms — ${run.v.symbol} verdict ${run.v.id}`,
      );
      await this.sleep(wait);
    }
  }

  /**
   * A read retry must finish its wait inside READ_RETRY_WINDOW_MS of the attempt
   * (bounds CLAIM_STALE_MS). Before anything was sent or cancelled, an AI
   * (or PRICE_TRIGGER, aged from its fire) attempt must also still be within the
   * verdict's max age when its wait ends.
   * Once a protective order was cancelled (or an order sent) age no longer
   * applies: giving up then leaves the position unprotected/uncertain.
   */
  private mayRetryRead(run: Run, wait: number): boolean {
    const elapsed = Math.max(0, Date.now() - run.startedMs);
    if (elapsed + wait > READ_RETRY_WINDOW_MS) return false;
    if (run.trigger !== 'MANUAL' && !run.sent && !run.cancelSent) {
      const age = run.now.getTime() - run.v.createdAt.getTime() + elapsed + wait;
      if (age > run.cfg.maxVerdictAgeSec * 1000) return false;
    }
    return true;
  }

  /**
   * Ruling R3 + R16: fresh positions + order book, inside the lease, before EVERY order.
   * `allowCancel` (the first check of an attempt only, never the re-check after a
   * cancel nor the LIMIT fallback): with AI_AUTO_EXIT_CANCEL_PROTECTIVE on, open
   * orders that are ALL protective come back as `protective` instead of OPEN_ORDER_EXISTS.
   */
  private async preOrderCheck(s: UserBrokerSession, t: Tracker, run: Run, allowCancel = false): Promise<PreCheck> {
    const pos = await this.readRows(run, 'positions', () => s.getPositionsEnvelope());
    if (pos.rows === null) return { kind: 'fail', reason: 'BROKER_READ', detail: pos.detail };
    const rows = pos.rows;
    const exchange = String(t.exchange ?? '').toUpperCase();
    const plan = planExitOrder(
      rows,
      { exchange: t.exchange, token: t.token, trackerQty: t.qty, lotSize: run.inst?.lotSize ?? null },
      { mode: run.cfg.mode, qtyUnit: run.cfg.qtyUnits[exchange] },
    );
    if (!plan.ok) return { kind: 'skip', reason: plan.reason };
    const ob = await this.readRows(run, 'order book', () => s.getOrderBookEnvelope());
    if (ob.rows === null) return { kind: 'fail', reason: 'ORDER_BOOK_READ', detail: ob.detail };
    const book = ob.rows;
    // Review fix 2: one AI exit per contract per day — an earlier one (even of
    // unknown fate) may have closed or be closing this position already.
    if (hasPriorAiExit(book, plan.order.exchange, plan.order.token)) return { kind: 'skip', reason: 'PRIOR_AI_EXIT_TODAY' };
    if (hasOpenOrderFor(book, plan.order.exchange, plan.order.token)) {
      if (allowCancel && run.cfg.cancelProtective) {
        const scan = protectiveOrdersFor(book, {
          exchange: plan.order.exchange, token: plan.order.token, side: plan.order.side,
          quantity: plan.order.quantity, positionType: plan.order.positionType,
        });
        if (scan.kind === 'protective') {
          return { kind: 'protective', order: plan.order, ltp: plan.ltp, unitVerified: plan.unitVerified, orders: scan.orders };
        }
      }
      return { kind: 'skip', reason: 'OPEN_ORDER_EXISTS' };
    }
    return { kind: 'ok', order: plan.order, ltp: plan.ltp, unitVerified: plan.unitVerified };
  }

  /** Ruling R10. Places nothing except the single R2 fallback (MARKET leg only). */
  private async confirm(
    s: UserBrokerSession, run: Run, o: OrderRequest, orderId: string, leg: 'M' | 'L',
  ): Promise<AiExitOutcome> {
    const { id, v } = run;
    let last: OrderFill | null = null;
    for (const step of CONFIRM_STEPS_MS) {
      await this.sleep(step);
      const book = await this.rows(() => s.getOrderBookEnvelope());
      last = book ? findOrderFill(book, orderId) ?? last : last;
      if (last && isTerminalOrderStatus(last.status)) break;
    }
    if (last?.status === 'rejected') {
      if (leg === 'M' && isMarketRefusal(last.text)) {
        await this.repo.update(id, { orderStatus: 'rejected', brokerMessage: last.text });
        return this.fallback(s, run, o, orderId);
      }
      return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { orderStatus: 'rejected', brokerMessage: last.text });
    }
    if (last?.status === 'cancelled') {
      return this.finish(id, v, 'REJECTED', 'CANCELLED', { orderStatus: 'cancelled', brokerMessage: last.text });
    }
    // E5 (plan item 12): Angel's positions lag its order book. A `complete` order IS
    // the fill: FILLED with its price/qty/exchange time even while positions lag.
    const rows = await this.rows(() => s.getPositionsEnvelope());
    const flat = !!rows && isFlat(rows, o.exchange, o.token);
    if (last?.status === 'complete') {
      if (!flat) {
        this.logger.log(`[exit-fill] ${o.symbol} order ${orderId} complete; positions not flat yet (broker lag) — FILLED from the order book`);
      }
      return this.finish(id, v, 'FILLED', undefined, {
        orderStatus: 'complete', fillPrice: last.averagePrice, fillQty: last.filledQty, fillAt: last.fillAt ?? new Date(),
      });
    }
    if (flat) {
      return this.finish(id, v, 'FILLED', undefined, {
        orderStatus: last?.status ?? null,
        ...(last ? { fillPrice: last.averagePrice, fillQty: last.filledQty, fillAt: last.fillAt } : {}),
      });
    }
    await this.repo.update(id, { orderStatus: last?.status ?? null });
    this.logger.log(`[ai-exit] ${o.symbol} order ${orderId} still ${last?.status ?? 'unseen'} after 10 s — left PLACED`);
    return { status: 'PLACED' };
  }

  /** Ruling R2/R3/R5: exactly one LIMIT, same quantity, fresh checks first. */
  private async fallback(
    s: UserBrokerSession, run: Run, first: OrderRequest, marketOrderId: string | null,
  ): Promise<AiExitOutcome> {
    const { id, v, cfg } = run;
    // Synthetic tracker: only the SIGN of qty is used (side check), which is unit-independent.
    const tracker: Tracker = { id: v.trackerId, userId: v.userId, status: 'OPEN', kind: 'POSITION',
      exchange: first.exchange, token: first.token, qty: first.side === 'SELL' ? first.quantity : -first.quantity };
    const pre = await this.preOrderCheck(s, tracker, run);
    if (pre.kind !== 'ok') return this.finish(id, v, 'FAILED', `FALLBACK_ABORTED:${refusal(pre)}`, { marketOrderId });
    if (pre.order.quantity !== first.quantity || pre.order.side !== first.side) {
      return this.finish(id, v, 'FAILED', 'FALLBACK_ABORTED:POSITION_CHANGED', { marketOrderId });
    }
    const price = limitFallbackPrice(first.side, pre.ltp, cfg.limitFallbackPct, tickRupees(run.inst?.tickSize, first.exchange));
    if (price === null) return this.finish(id, v, 'REJECTED', 'NO_LTP_FOR_LIMIT', { marketOrderId });

    const limit: OrderRequest = { ...pre.order, orderType: 'LIMIT', price };
    await this.repo.update(id, { orderType: 'LIMIT', limitPrice: price, marketOrderId });
    const r = await this.place(s, run, limit, 'L');
    this.logger.log(`[ai-exit] LIVE LIMIT ${limit.side} ${limit.quantity} ${limit.symbol} @ ${price} → ${r.status} ${r.orderId || ''} (${r.message}) — verdict ${v.id}`);
    if (r.status === 'PLACED' && r.orderId) {
      await this.repo.update(id, { status: 'PLACED', brokerOrderId: r.orderId, brokerMessage: r.message });
      return this.confirm(s, run, limit, r.orderId, 'L');
    }
    return this.settleUnplaced(s, run, limit, r, 'L');
  }

  private async finish(
    id: string, v: PendingVerdict, status: AiExitStatus, reason?: string,
    extra: Pick<AiExitPatch, 'orderStatus' | 'marketOrderId' | 'orderSentAt' | 'fillPrice' | 'fillQty' | 'fillAt' | 'gate'> & { brokerMessage?: string | null } = {},
    warn = false,
  ): Promise<AiExitOutcome> {
    await this.repo.update(id, { status, reason: reason ?? null, ...extra });
    const line = `[ai-exit] ${status}${reason ? `: ${reason}` : ''} — ${v.symbol} verdict ${v.id}`;
    if (warn || status === 'FAILED' || status === 'REJECTED') this.logger.warn(line);
    else this.logger.log(line);
    return reason ? { status, reason } : { status };
  }

  private warnCapOnce(userId: string, now: Date): void {
    const key = `${userId}|${istDayStartUtc(now).toISOString()}`;
    if (this.capWarned.has(key)) return;
    this.capWarned.add(key);
    this.logger.warn(`[ai-exit] daily cap reached for ${userId} — further EXIT_NOW verdicts are skipped today`);
  }
}
