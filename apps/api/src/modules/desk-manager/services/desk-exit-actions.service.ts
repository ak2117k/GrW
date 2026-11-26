import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SETUP_WATCH_MARKET, type SetupWatchMarket, type WatchRef } from '../../ai-setups/services/setup-watch.service';
import { parseAutoExitConfig } from '../../sentinel-executor/domain/auto-exit.config';
import { istDayStartUtc } from '../../sentinel-executor/domain/exit-order';
import { isHeld } from '../../sentinel-executor/domain/guards';
import { ManualExitService } from '../../sentinel-executor/services/manual-exit.service';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { isPaperTracker, tradeIdOf } from '../../trade-sentinel/paper/paper-tracker';
import type { ManagerTrackerLookup } from '../../trade-sentinel/ports/manager-trackers.port';
import type { ActionContext, ActionResult, PositionView } from '../domain/desk.types';

/** The paper trades the desk manager opens (Task 5's EntryEnginePaperService brand). */
export const DESK_MANAGER_STRATEGY = 'DESK_MANAGER';
/** The synthetic caller of a manager EXIT/BOOK (ManualExitService: the MANUAL trigger — no thesis gate, no AI cap). */
export const DESK_MANAGER_CALLER_EMAIL = 'desk-manager';
/** sentinel_verdicts.promptVersion / triggeredBy of a manager TIGHTEN (the trigger watch arms it, tighten-only). */
export const DESK_TIGHTEN_PROMPT_VERSION = 'desk-manager/1';
export const DESK_TIGHTEN_TAG = 'desk-manager';
export const DESK_TIGHTEN_REASON_PREFIX = 'DESK_MANAGER TIGHTEN:';

type ManualExit = Pick<ManualExitService, 'request'>;
type PaperCloser = Pick<TradeExecutionService, 'closeTrade'>;
type DeskMarket = Pick<SetupWatchMarket, 'underlyingRef' | 'ltps'>;

const OPEN_TRADE = new Set(['OPEN', 'PARTIALLY_FILLED', 'PENDING']);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: Pick<WatchRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * True when the position gains as the underlying rises: a long CE / FUT (or cash), a short PE. A long PE and a
 * short CE / FUT gain as it falls. Their stop on the underlying sits BELOW resp. ABOVE it.
 */
export function bullishExposure(symbol: string, qty: number): boolean {
  const s = String(symbol ?? '').trim().toUpperCase();
  const put = /\dPE$/.test(s);
  const long = !(qty < 0);
  return put ? !long : long;
}

/** Is `next` a tighter underlying stop than `current` for this exposure (strictly)? */
export function isTighter(bullish: boolean, next: number, current: number | null): boolean {
  if (current === null || !Number.isFinite(current)) return true;
  return bullish ? next > current : next < current;
}

/**
 * Desk manager EXIT / BOOK / TIGHTEN (plan Task 7, spec §5.4). Acts only through the existing executors:
 * - EXIT/BOOK live: ManualExitService as a system caller (MANUAL trigger: every position guard, open-order
 *   handling and in-flight lock; not GATED_THESIS_INTACT, not the AI daily cap). Own cap `maxExits` per IST day.
 *   The manager's own paper trades close through the paper close path (TradeExecutionService.closeTrade).
 * - TIGHTEN live: a synthetic HOLD verdict carrying an UNDERLYING exitTrigger, which TriggerWatchService arms
 *   through validateTrigger (tighten-only: a looser level is REJECTED LOOSENS and the next packet shows it).
 *   Paper trades: the stop is recorded and TargetWatchService enforces it.
 * Never acts on an AI_AUTO_EXIT_HOLD position; never loosens a manager stop. Never throws: every failure is a result.
 */
@Injectable()
export class DeskExitActions implements ManagerTrackerLookup {
  private readonly logger = new Logger(DeskExitActions.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ManualExitService) private readonly manual: ManualExitService | ManualExit,
    @Inject(TradeExecutionService) private readonly paper: TradeExecutionService | PaperCloser,
    // The owner-session market reads the AI setups use (underlying ref + LTP). Optional: absent ⇒ a live
    // TIGHTEN cannot name its watched instrument and FAILS loudly (NO_MARKET), never silently.
    @Optional() @Inject(SETUP_WATCH_MARKET) private readonly market?: DeskMarket | null,
  ) {}

  async exit(trackerId: string, kind: 'EXIT' | 'BOOK', reason: string, ctx: ActionContext): Promise<ActionResult> {
    try {
      const owner = ctx.cfg.ownerUserId;
      if (ctx.cfg.mode === 'off') return refused('MODE_OFF: the desk manager is off');
      if (!owner) return refused('NO_OWNER: HUB_OWNER_USER_ID is not set');
      const pos = this.positionOf(trackerId, ctx);
      if (this.heldPosition(trackerId, pos)) return refused(`OWNER_HOLD: ${pos?.symbol ?? trackerId} is on AI_AUTO_EXIT_HOLD`);
      const done = await this.exitsToday(owner, ctx.now);
      if (done >= ctx.cfg.maxExits) return refused(`EXIT_CAP: ${done} manager exits today ≥ DESK_MANAGER_MAX_EXITS ${ctx.cfg.maxExits}`);
      const why = `DESK_MANAGER ${kind}: ${String(reason ?? '').trim() || 'no reason given'}`;

      if (isPaperTracker(trackerId)) return await this.closePaper(tradeIdOf(trackerId), `DESK_MANAGER_${kind}`, why);
      if (ctx.cfg.mode !== 'live') return { status: 'RECORDED', detail: `shadow: ${kind} on live ${pos?.symbol ?? trackerId} recorded, not sent` };

      const r = await this.manual.request(
        { userId: owner, role: 'ADMIN', email: DESK_MANAGER_CALLER_EMAIL },
        trackerId,
        { now: ctx.now, reason: why },
      );
      if (!r.started) {
        return { status: 'PENDING', detail: `an exit attempt is already working (${r.row.status}, ${r.row.verdictId})`, ref: r.row.id };
      }
      void r.done
        .then((o) => this.logger.warn(`[desk-manager] ${kind} ${pos?.symbol ?? trackerId}: ${o ? o.status : 'no outcome'} (attempt ${r.row.id})`))
        .catch((err) => this.logger.error(`[desk-manager] ${kind} ${pos?.symbol ?? trackerId} attempt ${r.row.id}: ${errText(err)}`));
      return { status: 'DONE', detail: `${kind} sent through the exit executor (attempt ${r.row.verdictId})`, ref: r.row.id };
    } catch (err) {
      // ManualExitService refuses with 403/404/422 (closed tracker, not F&O, no qty unit): a refusal, not a crash.
      if (err instanceof HttpException) return refused(errText(err));
      return { status: 'FAILED', detail: errText(err) };
    }
  }

  async tighten(trackerId: string, underlyingStop: number, reason: string, ctx: ActionContext): Promise<ActionResult> {
    try {
      if (ctx.cfg.mode === 'off') return refused('MODE_OFF: the desk manager is off');
      const owner = ctx.cfg.ownerUserId;
      if (!owner) return refused('NO_OWNER: HUB_OWNER_USER_ID is not set');
      if (!Number.isFinite(underlyingStop) || underlyingStop <= 0) return refused(`BAD_STOP: ${underlyingStop}`);
      const pos = this.positionOf(trackerId, ctx);
      if (!pos) return refused(`NOT_IN_PACKET: tracker ${trackerId} is not an open position`);
      if (this.heldPosition(trackerId, pos)) return refused(`OWNER_HOLD: ${pos.symbol} is on AI_AUTO_EXIT_HOLD`);
      if (!pos.underlying) return refused(`NO_UNDERLYING: ${pos.symbol} has no underlying to stop on`);
      const bullish = bullishExposure(pos.symbol, pos.qty);
      const op: 'BELOW' | 'ABOVE' = bullish ? 'BELOW' : 'ABOVE';
      if (!isTighter(bullish, underlyingStop, pos.managerStop)) {
        return refused(`LOOSENS: ${pos.underlying} ${op} ${underlyingStop} is not tighter than the manager stop ${pos.managerStop}`);
      }
      const why = `${DESK_TIGHTEN_REASON_PREFIX} ${String(reason ?? '').trim() || 'no reason given'}`.slice(0, 500);

      if (isPaperTracker(trackerId)) {
        return { status: 'RECORDED', detail: `paper stop ${pos.underlying} ${op} ${underlyingStop} recorded — the target watch closes the paper trade on it` };
      }
      if (ctx.cfg.mode !== 'live') return { status: 'RECORDED', detail: `shadow: stop ${pos.underlying} ${op} ${underlyingStop} on live ${pos.symbol} recorded, not armed` };
      if (!this.market) return { status: 'FAILED', detail: 'NO_MARKET: the underlying market reads (SETUP_WATCH_MARKET) are not wired' };

      const watch = await this.market.underlyingRef(pos.underlying, ctx.now);
      if (!watch) return { status: 'FAILED', detail: `NO_UNDERLYING_REF: no priced line for ${pos.underlying}` };
      let seen: number | null = null;
      try {
        seen = (await this.market.ltps([watch], ctx.now)).get(keyOf(watch)) ?? null;
      } catch {
        seen = null; // audit only: the trigger watch re-reads the price before arming
      }
      const row = await this.prisma.sentinelVerdict.create({
        data: {
          userId: owner,
          trackerId,
          symbol: pos.symbol,
          verdict: 'HOLD',
          confidence: 'high',
          thesisStatus: pos.sentinel?.thesisStatus ?? 'INTACT',
          recoveryAvailable: false,
          reason: why,
          evidence: [] as Prisma.InputJsonValue,
          invalidationPoint: `${pos.underlying} ${bullish ? 'below' : 'above'} ${underlyingStop}`,
          reviewInSec: 0,
          packet: { source: DESK_TIGHTEN_TAG, runId: ctx.runId, decisionId: ctx.decisionId, underlyingStop, seen } as Prisma.InputJsonValue,
          promptVersion: DESK_TIGHTEN_PROMPT_VERSION,
          triggeredBy: [DESK_TIGHTEN_TAG] as Prisma.InputJsonValue,
          netPnl: pos.pnl ?? 0,
          greenFloor: null,
          exitTrigger: {
            v: 1,
            instrument: 'UNDERLYING',
            op,
            price: underlyingStop,
            watch: { exchange: watch.exchange, token: watch.token, symbol: watch.symbol },
            seen: { price: seen, at: ctx.now.toISOString() },
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      this.logger.warn(`[desk-manager] TIGHTEN ${pos.symbol}: exit if ${pos.underlying} ${op} ${underlyingStop}${seen !== null ? ` (now ${r2(seen)})` : ''} — verdict ${row.id}`);
      return { status: 'RECORDED', detail: `stop proposed: exit if ${pos.underlying} ${op} ${underlyingStop} — armed by the price-trigger watch (tighten-only)`, ref: row.id };
    } catch (err) {
      return { status: 'FAILED', detail: errText(err) };
    }
  }

  /** Closes one of the manager's OWN paper trades. Never a real-money close: anything else is REFUSED. */
  async closePaper(tradeId: string, tag: string, reason: string, exitPrice?: number): Promise<ActionResult> {
    try {
      const t = await this.prisma.trade.findUnique({ where: { id: tradeId }, select: { id: true, isPaperTrade: true, strategy: true, status: true } });
      if (!t) return refused(`NO_TRADE: paper trade ${tradeId} not found`);
      if (!t.isPaperTrade || t.strategy !== DESK_MANAGER_STRATEGY) return refused(`NOT_MANAGER_PAPER: trade ${tradeId} is not a paper ${DESK_MANAGER_STRATEGY} trade`);
      if (!OPEN_TRADE.has(String(t.status))) return refused(`TRADE_CLOSED: paper trade ${tradeId} is ${t.status}`);
      const closed = (await this.paper.closeTrade(tradeId, {
        exitReasonTag: tag,
        reason: reason.slice(0, 500),
        exitNotes: reason.slice(0, 2000),
        ...(exitPrice !== undefined && exitPrice > 0 ? { exitPrice } : {}),
      })) as { status?: string | null; pnl?: number | null };
      if (closed?.status !== 'CLOSED') return { status: 'PENDING', detail: `paper close lost to another close; trade is ${closed?.status ?? 'unknown'}` };
      return { status: 'DONE', detail: `paper trade ${tradeId} closed (${tag}), P&L ${closed.pnl ?? '?'}`, ref: tradeId };
    } catch (err) {
      return { status: 'FAILED', detail: errText(err) };
    }
  }

  /** Did the desk manager open this position? Live: a signal_orders row with source 'manager'; paper: its strategy. */
  async isManagerTracker(trackerId: string): Promise<boolean> {
    if (isPaperTracker(trackerId)) {
      const t = await this.prisma.trade.findUnique({ where: { id: tradeIdOf(trackerId) }, select: { strategy: true } });
      return t?.strategy === DESK_MANAGER_STRATEGY;
    }
    return (await this.prisma.signalOrder.count({ where: { trackerId, source: 'manager' } })) > 0;
  }

  /** The sentinel's per-pass question (ports/manager-trackers.port.ts): which of these live trackers are the manager's. */
  async managerTrackerIds(trackerIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = trackerIds.filter((id) => !isPaperTracker(id));
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.signalOrder.findMany({
      where: { trackerId: { in: [...ids] }, source: 'manager' },
      select: { trackerId: true },
    });
    return new Set(rows.map((r) => r.trackerId).filter((id): id is string => typeof id === 'string'));
  }

  private positionOf(trackerId: string, ctx: ActionContext): PositionView | null {
    const list = ctx.packet?.positions?.status === 'present' ? (ctx.packet.positions.value ?? []) : [];
    return list.find((p) => p.trackerId === trackerId) ?? null;
  }

  /** HOLD-listed by the packet or by AI_AUTO_EXIT_HOLD read now (symbol or tracker id, as the executor reads it). */
  private heldPosition(trackerId: string, pos: PositionView | null): boolean {
    if (pos?.held) return true;
    return isHeld(parseAutoExitConfig(process.env).hold, { id: trackerId, symbol: pos?.symbol });
  }

  private exitsToday(userId: string, now: Date): Promise<number> {
    return this.prisma.deskManagerDecision.count({
      where: { userId, action: { in: ['EXIT', 'BOOK'] }, status: { in: ['DONE', 'PENDING'] }, createdAt: { gte: istDayStartUtc(now) } },
    });
  }
}

function refused(detail: string): ActionResult {
  return { status: 'REFUSED', detail };
}
