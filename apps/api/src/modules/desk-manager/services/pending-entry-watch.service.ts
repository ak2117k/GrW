import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { AUTHORITY_STATE, TRADE_BRIEFS, type AuthorityStatePort, type TradeBriefsPort } from '../../exit-authority/exit-authority.tokens';
import { PAPER_TRACKER_PREFIX, isPaperTracker } from '../../trade-sentinel/paper/paper-tracker';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { authorityLive } from '../domain/authority';
import { openBrief, type OpenEntryFacts } from '../domain/trade-brief';
import type { ActionResult } from '../domain/desk.types';
import { DeskActionsRepository, type PendingEntryRow } from '../repositories/desk-actions.repository';
import { DESK_EXIT_ACTIONS, DESK_MARKET, type DeskExitActionsPort, type DeskMarket, type DeskRef } from './desk-actions.ports';
import { DeskActionsService, entryMet, watchPacket, type EntryStopState, type OpenDecision } from './desk-actions.service';

type Store = Pick<DeskActionsRepository, 'pendingRows' | 'filledSince' | 'move' | 'setResult' | 'orderTracker' | 'updateDecision'>;
type Firer = Pick<DeskActionsService, 'fire'>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: Pick<DeskRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;
/** signal_orders statuses that will never become a position. */
const DEAD_ORDER = new Set(['REJECTED', 'CANCELLED', 'FAILED']);
/** A FILLED row's stop is armed within this window (an UNCERTAIN order that never shows a tracker is given up). */
const STOP_WINDOW_MS = 24 * 3_600_000;

/** desk_manager_decisions.status for an action result. */
const decisionStatus = (r: ActionResult) => r.status;

/**
 * THE PENDING-ENTRY WATCH (plan Task 5, the SetupWatchService pattern). Every 5 s:
 * 1. each PENDING manager entry: expired at validUntil; else, when its underlying's live price meets the
 *    ZONE / BREAKOUT, the row is CLAIMED (PENDING → FILLED, conditional — a second pass / instance cannot fire it
 *    twice) and DeskActionsService.fire re-runs every OPEN refusal check before acting;
 * 2. each FILLED row (an order / paper trade exists or may) whose stop is still WAITING: once the position's
 *    tracker exists, the manager's underlying stop is armed through the exit actions (tighten-only trigger path).
 * The decision row follows the entry's outcome. Restart-safe: all state is in the DB.
 */
@Injectable()
export class PendingEntryWatchService {
  private readonly logger = new Logger(PendingEntryWatchService.name);
  private busy = false;

  constructor(
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    @Inject(DeskActionsRepository) private readonly store: Store,
    @Inject(DESK_MARKET) private readonly market: DeskMarket,
    @Inject(DeskActionsService) private readonly actions: Firer,
    @Optional() @Inject(DESK_EXIT_ACTIONS) private readonly exits?: DeskExitActionsPort,
    // Trade agent exit authority (Task 7 wires): live ⇒ a filled live OPEN gets its trade brief. Absent ⇒ off.
    @Optional() @Inject(TRADE_BRIEFS) private readonly briefs?: Pick<TradeBriefsPort, 'write'> | null,
    @Optional() @Inject(AUTHORITY_STATE) private readonly authority?: AuthorityStatePort | null,
  ) {}

  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.pass(new Date());
    } catch (err) {
      this.logger.warn(`[desk-manager] pending-entry pass failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async pass(now: Date): Promise<void> {
    await this.pendingPass(now);
    await this.stopPass(now);
  }

  private async pendingPass(now: Date): Promise<void> {
    const rows = await this.store.pendingRows();
    if (rows.length === 0) return;
    const live: PendingEntryRow[] = [];
    for (const row of rows) {
      if (now.getTime() >= row.validUntil.getTime()) await this.expire(row, now);
      else live.push(row);
    }
    if (live.length === 0) return;

    const refs = new Map<string, DeskRef>();
    for (const row of live) {
      try {
        const ref = await this.market.underlyingRef(row.underlying, now);
        if (ref) refs.set(row.id, ref);
      } catch (err) {
        this.logger.warn(`[desk-manager] ${row.underlying} line: ${errText(err)}`);
      }
    }
    if (refs.size === 0) return;
    const ltps = await this.market.ltps([...refs.values()], now).catch(() => new Map<string, number>());
    for (const row of live) {
      const ref = refs.get(row.id);
      const ltp = ref ? ltps.get(keyOf(ref)) : undefined;
      if (ltp === undefined || !(ltp > 0)) continue;
      if (!entryMet(row.decision as OpenDecision, ltp)) continue;
      if (!(await this.store.move(row.id, 'PENDING', 'FILLED', { result: { stage: 'firing', ltp, at: now.toISOString() } }))) continue;
      this.logger.warn(`[desk-manager] pending entry ${row.id} (${row.underlying}) met at ${ltp} — firing`);
      const r = await this.actions.fire(row, now).catch((err): ActionResult => ({ status: 'FAILED', detail: errText(err) }));
      await this.store
        .updateDecision(row.decisionId, { status: decisionStatus(r), result: { ...r, firedAt: now.toISOString(), underlyingLtp: ltp }, ...(r.ref ? (row.mode === 'live' ? { orderRowId: r.ref } : { tradeId: r.ref }) : {}) })
        .catch((err) => this.logger.warn(`[desk-manager] decision ${row.decisionId} not updated: ${errText(err)}`));
    }
  }

  private async expire(row: PendingEntryRow, now: Date): Promise<void> {
    const r: ActionResult = { status: 'REFUSED', detail: `EXPIRED: entry condition not met by ${row.validUntil.toISOString()}` };
    if (!(await this.store.move(row.id, 'PENDING', 'EXPIRED', { result: { ...r, at: now.toISOString() } }))) return;
    this.logger.log(`[desk-manager] pending entry ${row.id} (${row.underlying}) expired`);
    await this.store.updateDecision(row.decisionId, { status: 'REFUSED', result: r }).catch(() => undefined);
  }

  /** Arm the manager's underlying stop on every acted entry whose position now has a tracker. */
  private async stopPass(now: Date): Promise<void> {
    const rows = await this.store.filledSince(new Date(now.getTime() - STOP_WINDOW_MS));
    for (const row of rows) {
      const res = (row.result ?? {}) as Record<string, unknown>;
      const stop = res.stop as EntryStopState | undefined;
      if (!stop || stop.state !== 'WAITING') continue;
      const trackerId = await this.trackerOf(row);
      if (trackerId === 'DEAD') {
        await this.store.setResult(row.id, { ...res, stop: { ...stop, state: 'NO_FILL', detail: 'the entry order did not fill' } });
        continue;
      }
      if (!trackerId) continue;
      if (!this.exits) {
        this.logger.warn(`[desk-manager] entry ${row.id}: tracker ${trackerId} has no manager stop — exit actions not wired`);
        continue;
      }
      const d = row.decision as OpenDecision & { runId?: string };
      const ctx = { runId: d.runId ?? 'pending-entry-watch', decisionId: row.decisionId, now, packet: watchPacket(now, this.cfg.mode), cfg: this.cfg };
      let r: ActionResult;
      try {
        r = await this.exits.tighten(trackerId, stop.underlying, `DESK_MANAGER initial stop ${stop.underlying} on the underlying (decision ${row.decisionId})`, ctx);
      } catch (err) {
        r = { status: 'FAILED', detail: errText(err) };
      }
      const armed = r.status === 'DONE' || r.status === 'RECORDED' || r.status === 'PENDING';
      const brief = await this.writeOpenBrief(row, trackerId);
      await this.store.setResult(row.id, { ...res, trackerId, stop: { ...stop, state: armed ? 'ARMED' : 'FAILED', detail: r.detail, ref: r.ref }, ...(brief ? { brief } : {}) });
      if (!armed) {
        void sendOpsAlert(`desk-manager-stop:${row.id}`, `Desk manager: the stop ${stop.underlying} on ${row.underlying} (tracker ${trackerId}) was NOT armed — ${r.status}: ${r.detail}. The class catastrophe floor still applies.`);
      }
    }
  }

  /**
   * Trade agent exit authority: a live OPEN's position now has a tracker → its trade brief, composed from the OPEN
   * decision (openBrief), written via TRADE_BRIEFS (by 'OPEN'). Off / not wired / paper ⇒ nothing (null). A failed
   * write never blocks the stop; the manager is asked for a BRIEF next run (hasBrief false).
   */
  private async writeOpenBrief(row: PendingEntryRow, trackerId: string): Promise<{ state: 'WRITTEN' | 'FAILED'; detail?: string } | null> {
    if (!this.briefs || !authorityLive(this.authority) || row.mode !== 'live' || isPaperTracker(trackerId)) return null;
    const owner = this.cfg.ownerUserId ?? row.userId;
    try {
      const entry = ((row.result ?? {}) as Record<string, unknown>).entry as OpenEntryFacts | undefined;
      await this.briefs.write(trackerId, owner, openBrief(row.decision as OpenDecision, row.decisionId, entry ?? null), 'OPEN');
      return { state: 'WRITTEN' };
    } catch (err) {
      this.logger.warn(`[desk-manager] entry ${row.id}: trade brief for tracker ${trackerId} not written: ${errText(err)}`);
      return { state: 'FAILED', detail: errText(err).slice(0, 200) };
    }
  }

  /** The position's tracker id; 'DEAD' when the order will never fill; null = not yet. */
  private async trackerOf(row: PendingEntryRow): Promise<string | 'DEAD' | null> {
    if (row.tradeId) return `${PAPER_TRACKER_PREFIX}${row.tradeId}`;
    if (!row.orderRowId) return null;
    const o = await this.store.orderTracker(row.orderRowId).catch(() => null);
    if (!o) return null;
    if (o.trackerId) return o.trackerId;
    return DEAD_ORDER.has(String(o.status).toUpperCase()) ? 'DEAD' : null;
  }
}
