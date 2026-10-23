import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { QtyUnit } from '../../sentinel-executor/domain/auto-exit.types';
import { OwnerBrokerSessionProvider } from '../../sentinel-executor/services/owner-broker-session.provider';
import { findOrderByTag, isDeadOrderStatus } from '../../sentinel-executor/domain/exit-order';
import { findOrderFill } from '../../sentinel-executor/domain/exit-fill';
import type { ClassifiedPlacement, UserBrokerSession } from '../../auto-execution/services/per-user-broker-session.factory';
import { answeredPositions, TradeTrackerService } from '../../trade-tracker/services/trade-tracker.service';
import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';
import { isLiveTradingEnabled } from '../../trade-engine/live-trading';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { buildEntryOrder, signalOrderTag, slExitTrigger } from '../domain/execution';
import { fillAlert, rejectAlert } from '../domain/alerts';
import type { EntryPlan } from '../domain/gate';
import type { SignalProduct } from '../domain/signal-trader.config';

export const SIGNAL_SLEEP = Symbol('SIGNAL_SLEEP');
export type SignalSleep = (ms: number) => Promise<void>;
const defaultSleep: SignalSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Grace before reading the book after a non-definitive placement answer (auto-execution's value). */
const TAG_LOOKUP_DELAY_MS = 2_000;
const POLL_MS = 5_000;
const TRACKER_TRIES = 5;
const TRACKER_RETRY_MS = 3_000;

export type PlaceResult =
  | { kind: 'DUPLICATE' }
  | { kind: 'PLACED'; orderRowId: string; brokerOrderId: string }
  | { kind: 'REJECTED' | 'UNCERTAIN' | 'BLOCKED' | 'FAILED'; orderRowId: string | null; reason: string };

export interface PlaceInput {
  decisionId: string;
  ownerUserId: string;
  plan: EntryPlan;
  product: SignalProduct;
  qtyUnit: QtyUnit | null;
  channel: string;
  signalSummary: string;
  fillWaitSec: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class LateBlockError extends Error {}

/**
 * The live entry path for a TAKE (contract §X rule 3). Reuses the app's existing live order plumbing:
 * the owner's borrowed feed session (OwnerBrokerSessionProvider — never a second login over a live
 * feed), `UserBrokerSession.placeOrderClassified` with an `ordertag`, and the SmartAPI rules (the SDK
 * never rejects: `{}`/`{status}` is NOT a rejection → the book is read by our tag).
 *
 * At-most-once: the signal_orders row is CLAIMED (unique decisionId) BEFORE the broker call and is
 * never re-sent. ALWAYS a LIMIT order. The kill switch and LIVE_TRADING_ENABLED are re-checked inside
 * the session, last thing before the call. An unfilled LIMIT is cancelled after `fillWaitSec` (a
 * resting entry would block the sentinel's exits on the contract).
 */
@Injectable()
export class SignalExecutorService {
  private readonly logger = new Logger(SignalExecutorService.name);
  private readonly sleep: SignalSleep;

  constructor(
    private readonly repo: SignalTraderRepository,
    private readonly sessions: OwnerBrokerSessionProvider,
    private readonly trackers: TradeTrackerService,
    @Optional() @Inject(SIGNAL_SLEEP) sleep?: SignalSleep,
  ) {
    this.sleep = sleep ?? defaultSleep;
  }

  async place(i: PlaceInput): Promise<PlaceResult> {
    const order = buildEntryOrder(i.plan, i.product, i.qtyUnit); // throws on anything but a LIMIT
    if (order.orderType !== 'LIMIT') throw new Error('signal entries are LIMIT only');
    const orderTag = signalOrderTag(i.decisionId);
    const rowId = await this.repo.claimOrder({
      decisionId: i.decisionId,
      userId: i.ownerUserId,
      exchange: i.plan.exchange,
      token: i.plan.token,
      tradingsymbol: i.plan.tradingsymbol,
      qty: i.plan.qty,
      lots: i.plan.lots,
      side: i.plan.side,
      productType: i.product,
      limitPrice: i.plan.limitPrice,
      sl: i.plan.sl,
      targets: i.plan.targets,
      orderTag,
    });
    if (!rowId) {
      this.logger.warn(`[signal-exec] decision ${i.decisionId} already has an order — nothing sent`);
      return { kind: 'DUPLICATE' };
    }

    let sent = false;
    let settled: { kind: 'PLACED'; orderId: string } | { kind: 'REJECTED' | 'UNCERTAIN'; reason: string };
    try {
      settled = await this.sessions.withOwnerSession(
        i.ownerUserId,
        async (session) => {
          if (!isLiveTradingEnabled()) throw new LateBlockError('LIVE_TRADING_ENABLED switched off');
          if (!(await coreEntryAllowed('signal-trader', { userId: i.ownerUserId, ref: i.plan.tradingsymbol, recheck: true }))) {
            throw new LateBlockError('core kill switch engaged');
          }
          sent = true;
          let placement: ClassifiedPlacement;
          try {
            placement = await session.placeOrderClassified(order, orderTag);
          } catch (err) {
            placement = { status: 'UNCERTAIN', orderId: '', message: errText(err) };
          }
          return this.settle(session, placement, orderTag);
        },
        { allowEphemeralLogin: true },
      );
    } catch (err) {
      if (err instanceof LateBlockError) {
        await this.repo.updateOrder(rowId, { status: 'FAILED', statusReason: `BLOCKED: ${err.message}` });
        return { kind: 'BLOCKED', orderRowId: rowId, reason: err.message };
      }
      const why = errText(err);
      const status = sent ? 'UNCERTAIN' : 'FAILED';
      await this.repo.updateOrder(rowId, { status, statusReason: `${sent ? 'FAULT_AFTER_SEND' : 'NOT_SENT'}: ${why}` });
      void sendOpsAlert(`signal-order:${rowId}`, rejectAlert({ symbol: i.plan.tradingsymbol, status, reason: `${why}${sent ? ' — the order MAY exist, check the broker' : ''}` }));
      return { kind: sent ? 'UNCERTAIN' : 'FAILED', orderRowId: rowId, reason: why };
    }

    if (settled.kind === 'PLACED') {
      await this.repo.updateOrder(rowId, { status: 'PLACED', brokerOrderId: settled.orderId });
      this.logger.warn(`[signal-exec] PLACED LIMIT ${i.plan.side} ${i.plan.tradingsymbol} x${order.quantity} @ ${i.plan.limitPrice} (order ${settled.orderId}, tag ${orderTag})`);
      void this.followUp(rowId, settled.orderId, orderTag, i).catch((err) =>
        this.logger.error(`[signal-exec] follow-up for ${rowId} failed: ${errText(err)}`),
      );
      return { kind: 'PLACED', orderRowId: rowId, brokerOrderId: settled.orderId };
    }
    await this.repo.updateOrder(rowId, { status: settled.kind, statusReason: settled.reason });
    void sendOpsAlert(
      `signal-order:${rowId}`,
      rejectAlert({ symbol: i.plan.tradingsymbol, status: settled.kind, reason: settled.kind === 'UNCERTAIN' ? `${settled.reason} — the order MAY exist, check the broker` : settled.reason }),
    );
    return { kind: settled.kind, orderRowId: rowId, reason: settled.reason };
  }

  /** Classified answer → settlement; only a non-definitive answer reads the book, by OUR tag. Never re-sends. */
  private async settle(session: UserBrokerSession, p: ClassifiedPlacement, tag: string) {
    if (p.status === 'PLACED') return { kind: 'PLACED' as const, orderId: p.orderId };
    if (p.status === 'REJECTED') return { kind: 'REJECTED' as const, reason: p.message };
    await this.sleep(TAG_LOOKUP_DELAY_MS);
    let book: unknown[] | null = null;
    try {
      book = answeredPositions(await session.getOrderBookEnvelope());
    } catch {
      book = null;
    }
    if (book === null) return { kind: 'UNCERTAIN' as const, reason: `ORDER_BOOK_NOT_ANSWERED: ${p.message}` };
    const mine = findOrderByTag(book, tag);
    if (!mine) return { kind: 'UNCERTAIN' as const, reason: `TAG_NOT_IN_ORDER_BOOK: ${p.message}` };
    if (isDeadOrderStatus(mine.status)) return { kind: 'REJECTED' as const, reason: mine.text || p.message };
    return { kind: 'PLACED' as const, orderId: mine.orderId || `tag:${tag}` };
  }

  /** Read our order from the book until it fills, dies, or the wait ends (then cancel it). */
  async followUp(rowId: string, brokerOrderId: string, tag: string, i: Pick<PlaceInput, 'ownerUserId' | 'plan' | 'channel' | 'signalSummary' | 'fillWaitSec'>): Promise<void> {
    const deadline = Date.now() + i.fillWaitSec * 1000;
    let cancelSent = false;
    for (let n = 0; n < 400; n++) {
      await this.sleep(POLL_MS);
      let rows: unknown[] | null = null;
      try {
        rows = await this.sessions.withOwnerSession(i.ownerUserId, async (s) => answeredPositions(await s.getOrderBookEnvelope()));
      } catch (err) {
        this.logger.warn(`[signal-exec] order book read failed for ${rowId}: ${errText(err)}`);
      }
      if (rows) {
        const byId = brokerOrderId.startsWith('tag:') ? null : findOrderFill(rows, brokerOrderId);
        const byTag = findOrderByTag(rows, tag);
        const status = byId?.status ?? byTag?.status ?? '';
        const filledQty = byId?.filledQty ?? null;
        if (status === 'complete') {
          await this.onFill(rowId, byId?.averagePrice ?? i.plan.limitPrice, filledQty ?? i.plan.qty, byId?.fillAt ?? new Date(), 'FILLED', i);
          return;
        }
        if (status === 'rejected' || status === 'cancelled') {
          if (filledQty && filledQty > 0) {
            await this.onFill(rowId, byId?.averagePrice ?? i.plan.limitPrice, filledQty, byId?.fillAt ?? new Date(), 'PARTIAL', i);
          } else {
            const st = status === 'rejected' ? 'REJECTED' : 'CANCELLED';
            const reason = byId?.text || byTag?.text || (cancelSent ? `unfilled after ${i.fillWaitSec} s — cancelled` : status);
            await this.repo.updateOrder(rowId, { status: st, statusReason: reason });
            void sendOpsAlert(`signal-order:${rowId}`, rejectAlert({ symbol: i.plan.tradingsymbol, status: st, reason }));
          }
          return;
        }
      }
      if (!cancelSent && Date.now() >= deadline && !brokerOrderId.startsWith('tag:')) {
        cancelSent = true;
        try {
          const c = await this.sessions.withOwnerSession(i.ownerUserId, (s) => s.cancelOrderClassified('NORMAL', brokerOrderId));
          this.logger.warn(`[signal-exec] cancel of unfilled ${brokerOrderId}: ${c.status} ${c.message}`);
        } catch (err) {
          this.logger.warn(`[signal-exec] cancel of ${brokerOrderId} failed: ${errText(err)}`);
        }
      }
      if (Date.now() > deadline + 10 * 60_000) {
        await this.repo.updateOrder(rowId, { status: 'UNCERTAIN', statusReason: 'order state unresolved 10 min after the fill wait' });
        void sendOpsAlert(`signal-order:${rowId}`, rejectAlert({ symbol: i.plan.tradingsymbol, status: 'UNCERTAIN', reason: 'order state unresolved — check the broker' }));
        return;
      }
    }
  }

  /**
   * Fill → the sentinel watches it: the tracker is created by the standard reconcile (positions read),
   * the signal plan becomes the USER thesis (SL = invalidation, T1 = target), and the SL becomes an
   * explicit exitTrigger the price-trigger watch arms.
   */
  async onFill(
    rowId: string,
    price: number,
    qty: number,
    at: Date,
    status: 'FILLED' | 'PARTIAL',
    i: Pick<PlaceInput, 'ownerUserId' | 'plan' | 'channel' | 'signalSummary'>,
  ): Promise<void> {
    await this.repo.updateOrder(rowId, { status, fillPrice: price, fillQty: Math.round(qty), filledAt: at });
    const handOff = await this.handOff(rowId, price, at, i);
    void sendOpsAlert(
      `signal-fill:${rowId}`,
      fillAlert({ symbol: i.plan.tradingsymbol, side: i.plan.side, qty, price, sl: i.plan.sl, slArmed: handOff }),
    );
  }

  async handOff(rowId: string, price: number, at: Date, i: Pick<PlaceInput, 'ownerUserId' | 'plan' | 'channel' | 'signalSummary'>): Promise<string> {
    let tracker = await this.repo.findOpenTracker(i.ownerUserId, i.plan.token);
    for (let n = 0; !tracker && n < TRACKER_TRIES; n++) {
      try {
        await this.trackers.backfill(i.ownerUserId, { positionsOnly: true });
      } catch (err) {
        this.logger.warn(`[signal-exec] tracker reconcile failed: ${errText(err)}`);
      }
      tracker = await this.repo.findOpenTracker(i.ownerUserId, i.plan.token);
      if (!tracker) await this.sleep(TRACKER_RETRY_MS);
    }
    if (!tracker) {
      await this.repo.updateOrder(rowId, { statusReason: 'NO_TRACKER: SL not handed to the sentinel' });
      return 'NOT HANDED OFF — no trade tracker appeared; watch this position manually';
    }
    const p = i.plan;
    const t = p.targets;
    await this.repo.writeThesis({
      trackerId: tracker.id,
      userId: i.ownerUserId,
      direction: p.side === 'BUY' ? 'LONG' : 'SHORT',
      reason: `Telegram signal (${i.channel}): ${i.signalSummary}. Entry ${price}, SL ${p.sl}, targets ${t.length ? t.join(' / ') : 'none'}.`,
      levelPrice: price,
      targetPrice: t[0] ?? null,
      invalidation: p.sl,
    });
    const verdictId = await this.repo.recordSlVerdict({
      userId: i.ownerUserId,
      trackerId: tracker.id,
      symbol: tracker.symbol,
      reason: `Signal entry plan (${i.channel}): exit if ${p.tradingsymbol} ${p.side === 'BUY' ? '<' : '>'} ${p.sl} (signal SL).`,
      invalidationPoint: `${p.tradingsymbol} ${p.side === 'BUY' ? 'below' : 'above'} ${p.sl}`,
      exitTrigger: slExitTrigger(p, { price, at: at.toISOString() }),
      packet: { source: 'signal-trader', orderId: rowId, entry: price, sl: p.sl, targets: t },
    });
    await this.repo.updateOrder(rowId, { trackerId: tracker.id, slVerdictId: verdictId });
    return `thesis set; SL trigger proposed (verdict ${verdictId}) — armed by the price-trigger watch`;
  }

  /** Graceful recovery: resume follow-ups of orders sent before a restart. */
  async resume(rows: Array<{ id: string; brokerOrderId: string | null; orderTag: string; userId: string; exchange: string; token: string; tradingsymbol: string; side: string; qty: number; lots: number | null; limitPrice: number; sl: number; targets: unknown }>, fillWaitSec: number): Promise<void> {
    for (const r of rows) {
      if (!r.brokerOrderId) continue;
      const plan = {
        exchange: r.exchange, token: r.token, tradingsymbol: r.tradingsymbol, side: r.side as 'BUY' | 'SELL',
        qty: r.qty, lots: r.lots ?? r.qty, limitPrice: r.limitPrice, sl: r.sl,
        targets: Array.isArray(r.targets) ? (r.targets as number[]) : [],
      } as EntryPlan;
      void this.followUp(r.id, r.brokerOrderId, r.orderTag, { ownerUserId: r.userId, plan, channel: 'resumed', signalSummary: r.tradingsymbol, fillWaitSec }).catch((err) =>
        this.logger.error(`[signal-exec] resumed follow-up ${r.id} failed: ${errText(err)}`),
      );
    }
  }
}
