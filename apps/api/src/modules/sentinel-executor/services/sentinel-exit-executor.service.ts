// apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
import type {
  ClassifiedPlacement,
  UserBrokerSession,
} from '../../auto-execution/services/per-user-broker-session.factory';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import type { SessionClock } from '../../market-hub/session-clock';
import type { AiExitStatus, AutoExitConfig } from '../domain/auto-exit.types';
import {
  aiExitOrderTag,
  findOrder,
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
import { evaluateGuards } from '../domain/guards';
import type { ExitTrigger } from '../domain/manual-exit';
import {
  AiExitExecutionRepository,
  type PendingVerdict,
} from '../repositories/ai-exit-execution.repository';
import { FeedSessionNotReadyError, NoFeedSessionError, OwnerBrokerSessionProvider } from './owner-broker-session.provider';

export const AI_EXIT_SESSION_CLOCK = Symbol('AI_EXIT_SESSION_CLOCK');
export const AI_EXIT_SLEEP = Symbol('AI_EXIT_SLEEP');
export type Sleep = (ms: number) => Promise<void>;
export type AiExitOutcome = { status: AiExitStatus | 'DUPLICATE'; reason?: string };

/** Plan R10: order-book checks at +2 s, +5 s, +10 s after placing. */
const CONFIRM_STEPS_MS = [2_000, 3_000, 5_000];
/** Review fix 1: grace before looking for an order whose placement answer was not definitive. */
const TAG_LOOKUP_DELAY_MS = 2_000;

type Tracker = { id: string; userId: string; status: string; kind: string; exchange: string; token: string; qty: number };
type Inst = { tickSize: number | null; lotSize: number | null } | null;
type PreCheck =
  | { kind: 'ok'; order: OrderRequest; ltp: number; unitVerified: boolean }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

/** Per-verdict state threaded through the flow. `sent` flips the moment placeOrder is invoked. */
interface Run {
  id: string;
  v: PendingVerdict;
  cfg: AutoExitConfig;
  inst: Inst;
  sent: boolean;
  trigger: ExitTrigger;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

    const run: Run = { id, v, cfg, inst, sent: false, trigger };

    // 3–7. BROKER — one session lease, tier chosen once (ruling R1).
    try {
      return await this.sessions.withOwnerSession(v.userId, async (s, source) => {
        await this.repo.update(id, { sessionSource: source });
        const pre = await this.preOrderCheck(s, t, run);
        if (pre.kind !== 'ok') return this.finish(id, v, pre.kind === 'skip' ? 'SKIPPED' : 'FAILED', pre.reason);
        const o = pre.order;
        await this.repo.update(id, {
          exchange: o.exchange, token: o.token, side: o.side, quantity: o.quantity,
          productType: o.positionType, orderType: 'MARKET',
        });

        if (cfg.mode === 'dry-run') {
          const what = `would ${o.side} ${o.quantity} ${o.symbol} (${o.positionType}) at MARKET`;
          // R16: the table has no flag column, so an unverified unit is stated in the reason.
          const reason = pre.unitVerified ? what : `UNIT_UNVERIFIED: ${what}`;
          this.logger.log(`[ai-exit] DRY-RUN ${reason} — verdict ${v.id}: ${v.reason}`);
          await this.repo.update(id, { status: 'DRY_RUN', reason });
          return { status: 'DRY_RUN', reason };
        }
        // Belt and braces: planExitOrder never returns an unverified plan in live mode.
        if (!pre.unitVerified) return this.finish(id, v, 'SKIPPED', `QTY_UNIT_UNCONFIGURED:${o.exchange}`);

        const r = await this.place(s, run, o, 'M');
        this.logger.log(`[ai-exit] LIVE MARKET ${o.side} ${o.quantity} ${o.symbol} → ${r.status} ${r.orderId || ''} (${r.message}) — verdict ${v.id}`);
        if (r.status === 'PLACED' && r.orderId) {
          await this.repo.update(id, { status: 'PLACED', brokerOrderId: r.orderId, brokerMessage: r.message });
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
      return this.finish(id, v, 'FAILED', run.sent ? 'ORDER_UNCERTAIN' : 'SESSION', { brokerMessage: errText(err) });
    }
  }

  /** The ONLY call site of placeOrder. Marks the run as sent before the call. */
  private place(s: UserBrokerSession, run: Run, o: OrderRequest, leg: 'M' | 'L'): Promise<ClassifiedPlacement> {
    run.sent = true;
    return s.placeOrderClassified(o, aiExitOrderTag(run.v.id, leg, run.trigger));
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
    const definitive = r.status === 'REJECTED';
    if (!definitive) await this.sleep(TAG_LOOKUP_DELAY_MS);
    const book = await this.rows(() => s.getOrderBookEnvelope());
    if (book === null) return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message });
    const mine = findOrderByTag(book, aiExitOrderTag(v.id, leg, run.trigger));

    if (mine && mine.status !== 'rejected' && mine.status !== 'cancelled') {
      this.logger.warn(`[ai-exit] ${o.symbol} placement answer was "${r.message}" but order ${mine.orderId || '?'} (${mine.status || 'unknown'}) carries our tag — treating as PLACED`);
      await this.repo.update(id, { status: 'PLACED', brokerOrderId: mine.orderId || null, brokerMessage: r.message, orderStatus: mine.status || null });
      return mine.orderId ? this.confirm(s, run, o, mine.orderId, leg) : { status: 'PLACED' };
    }
    if (mine) {
      const text = mine.text || r.message;
      if (mine.status === 'rejected' && leg === 'M' && isMarketRefusal(text)) {
        await this.repo.update(id, { orderStatus: 'rejected', brokerMessage: text });
        return this.fallback(s, run, o, mine.orderId || null);
      }
      return this.finish(id, v, 'REJECTED', mine.status === 'cancelled' ? 'CANCELLED' : 'BROKER_REJECTED', {
        orderStatus: mine.status, brokerMessage: text,
      });
    }
    if (definitive) {
      if (leg === 'M' && isMarketRefusal(r.message)) {
        await this.repo.update(id, { brokerMessage: r.message });
        return this.fallback(s, run, o, null);
      }
      return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { brokerMessage: r.message });
    }
    return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message });
  }

  /** A broker read whose throw (timeout, disposed) is treated as "not answered". */
  private async rows(read: () => Promise<unknown>): Promise<unknown[] | null> {
    try {
      return answeredPositions(await read());
    } catch (err) {
      this.logger.warn(`[ai-exit] broker read failed: ${errText(err)}`);
      return null;
    }
  }

  /** Ruling R3 + R16: fresh positions + order book, inside the lease, before EVERY order. */
  private async preOrderCheck(s: UserBrokerSession, t: Tracker, run: Run): Promise<PreCheck> {
    const rows = await this.rows(() => s.getPositionsEnvelope());
    if (rows === null) return { kind: 'fail', reason: 'BROKER_READ' };
    const exchange = String(t.exchange ?? '').toUpperCase();
    const plan = planExitOrder(
      rows,
      { exchange: t.exchange, token: t.token, trackerQty: t.qty, lotSize: run.inst?.lotSize ?? null },
      { mode: run.cfg.mode, qtyUnit: run.cfg.qtyUnits[exchange] },
    );
    if (!plan.ok) return { kind: 'skip', reason: plan.reason };
    const book = await this.rows(() => s.getOrderBookEnvelope());
    if (book === null) return { kind: 'fail', reason: 'ORDER_BOOK_READ' };
    // Review fix 2: one AI exit per contract per day — an earlier one (even of
    // unknown fate) may have closed or be closing this position already.
    if (hasPriorAiExit(book, plan.order.exchange, plan.order.token)) return { kind: 'skip', reason: 'PRIOR_AI_EXIT_TODAY' };
    if (hasOpenOrderFor(book, plan.order.exchange, plan.order.token)) return { kind: 'skip', reason: 'OPEN_ORDER_EXISTS' };
    return { kind: 'ok', order: plan.order, ltp: plan.ltp, unitVerified: plan.unitVerified };
  }

  /** Ruling R10. Places nothing except the single R2 fallback (MARKET leg only). */
  private async confirm(
    s: UserBrokerSession, run: Run, o: OrderRequest, orderId: string, leg: 'M' | 'L',
  ): Promise<AiExitOutcome> {
    const { id, v } = run;
    let last: { status: string; text: string } | null = null;
    for (const step of CONFIRM_STEPS_MS) {
      await this.sleep(step);
      const book = await this.rows(() => s.getOrderBookEnvelope());
      last = book ? findOrder(book, orderId) ?? last : last;
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
    const rows = await this.rows(() => s.getPositionsEnvelope());
    if (rows && isFlat(rows, o.exchange, o.token)) {
      return this.finish(id, v, 'FILLED', undefined, { orderStatus: last?.status ?? null });
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
    if (pre.kind !== 'ok') return this.finish(id, v, 'FAILED', `FALLBACK_ABORTED:${pre.reason}`, { marketOrderId });
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
    extra: { brokerMessage?: string; orderStatus?: string | null; marketOrderId?: string | null } = {},
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
