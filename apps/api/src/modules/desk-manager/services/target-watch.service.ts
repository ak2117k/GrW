import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SETUP_WATCH_MARKET, type SetupWatchMarket, type WatchRef } from '../../ai-setups/services/setup-watch.service';
import { AUTHORITY_STATE, TRADE_ALARMS, type AuthorityStatePort, type TradeAlarmsPort } from '../../exit-authority/exit-authority.tokens';
import { paperTrackerId, isPaperTracker, tradeIdOf } from '../../trade-sentinel/paper/paper-tracker';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { authorityLive } from '../domain/authority';
import type { ActionResult, DeskPacket, PositionView, WakeReason } from '../domain/desk.types';
import { DeskExitActions, isTighter } from './desk-exit-actions.service';

/**
 * How code wakes the manager runner (Task 4's ManagerRunnerService.wake), injected by token so this file does
 * not import the runner. Task 8 binds it (`{ provide: DESK_WAKE, useExisting: ManagerRunnerService }`).
 */
export const DESK_WAKE = Symbol('DESK_WAKE');
export interface DeskWakePort {
  wake(reason: WakeReason, now?: Date): void;
}

/** After a target is crossed, the manager has this long to BOOK / TIGHTEN / EXIT before code locks the profit. */
export const TARGET_LOCK_AFTER_MS = 60_000;
/** Manager OPENs looked back this far for still-open positions (an MCX / carried position can outlive the day). */
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** runId of the decision rows the target lock writes (no manager run behind them). */
export const TARGET_LOCK_RUN_ID = 'target-lock';

const OPEN_TRADE = new Set(['OPEN', 'PARTIALLY_FILLED', 'PENDING']);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: Pick<WatchRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

type DeskMarket = Pick<SetupWatchMarket, 'underlyingRef' | 'ltps'>;

/** One open manager position the watch looks after. */
export interface ManagedPosition {
  trackerId: string;
  openDecisionId: string;
  underlying: string;
  symbol: string;
  exchange: string;
  qty: number;
  entry: number;
  /** Gains as the underlying rises (BUY_CE / BUY_FUT). */
  bullish: boolean;
  /** The underlying at entry (lock level for the first target); null when unknown. */
  entryRef: number | null;
  /** Targets on the underlying, nearest first in the position's favour. */
  targets: number[];
  /** The tightest manager stop so far (OPEN stop, then every RECORDED / DONE TIGHTEN). */
  stop: number | null;
}

interface CrossState {
  /** Targets reached so far (never decreases). */
  reached: number;
  /** When `reached` last went up (ms). */
  at: number;
  /** `reached` the last lock (or manager decision) settled. */
  settled: number;
}

/**
 * Target lock (spec §5.4 "Targets"), every 5 s while the desk manager is on:
 * - when the underlying crosses a manager position's next target, the manager is woken at once
 *   (`target_crossed`) to BOOK or TIGHTEN;
 * - with no EXIT / BOOK / TIGHTEN decision for that tracker within 60 s, code tightens the stop to the previous
 *   target (to the entry for the first) through DeskExitActions.tighten — never looser than the stop in force;
 * - the manager's own PAPER trades have no armed trigger, so their manager stop is enforced here (paper close).
 * Live stops are enforced by the sentinel's price-trigger watch (TIGHTEN arms it).
 */
@Injectable()
export class TargetWatchService {
  private readonly logger = new Logger(TargetWatchService.name);
  private readonly crossed = new Map<string, CrossState>();
  private busy = false;
  private warnedNoMarket = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly exits: DeskExitActions,
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    @Optional() @Inject(SETUP_WATCH_MARKET) private readonly market?: DeskMarket | null,
    @Optional() @Inject(DESK_WAKE) private readonly waker?: DeskWakePort | null,
    // Trade agent exit authority (Task 7 wires): live ⇒ a live position's lock is a TARGET_LOCK alarm. Absent ⇒ off.
    @Optional() @Inject(TRADE_ALARMS) private readonly alarms?: Pick<TradeAlarmsPort, 'raise'> | null,
    @Optional() @Inject(AUTHORITY_STATE) private readonly authority?: AuthorityStatePort | null,
  ) {}

  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !this.cfg.ownerUserId || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.pass(new Date());
    } catch (err) {
      this.logger.warn(`[desk-target] pass failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** One pass (public for specs). Never throws per position. */
  async pass(now: Date): Promise<void> {
    const owner = this.cfg.ownerUserId;
    if (this.cfg.mode === 'off' || !owner) return;
    const positions = await this.load(owner, now);
    for (const id of [...this.crossed.keys()]) if (!positions.some((p) => p.trackerId === id)) this.crossed.delete(id);
    if (positions.length === 0) return;
    if (!this.market) {
      if (!this.warnedNoMarket) this.logger.error('[desk-target] SETUP_WATCH_MARKET not wired — manager targets and paper stops are NOT watched');
      this.warnedNoMarket = true;
      return;
    }
    const refs = new Map<string, WatchRef>();
    for (const p of positions) {
      if (refs.has(p.underlying)) continue;
      try {
        const ref = await this.market.underlyingRef(p.underlying, now);
        if (ref) refs.set(p.underlying, ref);
      } catch (err) {
        this.logger.warn(`[desk-target] ${p.underlying}: no underlying ref (${errText(err)})`);
      }
    }
    if (refs.size === 0) return;
    const ltps = await this.market.ltps([...refs.values()], now);
    for (const p of positions) {
      const ref = refs.get(p.underlying);
      const ltp = ref ? (ltps.get(keyOf(ref)) ?? null) : null;
      if (ltp === null) continue;
      try {
        await this.step(p, ltp, now);
      } catch (err) {
        this.logger.warn(`[desk-target] ${p.symbol} (tracker ${p.trackerId}): ${errText(err)}`);
      }
    }
  }

  private async step(p: ManagedPosition, ltp: number, now: Date): Promise<void> {
    // Paper: the manager stop has no armed trigger — enforce it here.
    if (isPaperTracker(p.trackerId) && p.stop !== null && (p.bullish ? ltp <= p.stop : ltp >= p.stop)) {
      const r = await this.exits.closePaper(
        tradeIdOf(p.trackerId),
        'DESK_MANAGER_STOP',
        `DESK_MANAGER stop: ${p.underlying} ${ltp} ${p.bullish ? '≤' : '≥'} manager stop ${p.stop}`,
      );
      this.logger.warn(`[desk-target] paper stop ${p.symbol}: ${p.underlying} ${ltp} crossed ${p.stop} — ${r.status} ${r.detail}`);
      return;
    }

    const reached = p.targets.filter((t) => (p.bullish ? ltp >= t : ltp <= t)).length;
    const st = this.crossed.get(p.trackerId) ?? { reached: 0, at: 0, settled: 0 };
    if (reached > st.reached) {
      st.reached = reached;
      st.at = now.getTime();
      this.crossed.set(p.trackerId, st);
      this.logger.warn(`[desk-target] ${p.symbol}: ${p.underlying} ${ltp} crossed target ${reached} (${p.targets[reached - 1]}) — waking the manager`);
      this.waker?.wake('target_crossed', now);
      return;
    }
    if (st.reached <= st.settled || now.getTime() - st.at < TARGET_LOCK_AFTER_MS) return;

    // The manager answered (any EXIT / BOOK / TIGHTEN for this tracker since the cross): its call stands.
    const answered = await this.prisma.deskManagerDecision.count({
      where: {
        userId: this.cfg.ownerUserId as string,
        trackerId: p.trackerId,
        action: { in: ['EXIT', 'BOOK', 'TIGHTEN'] },
        // Acted or in flight; an INVALID / REFUSED / FAILED one did nothing, so the lock still applies.
        status: { in: ['VALID', 'DONE', 'RECORDED', 'PENDING'] },
        runId: { not: TARGET_LOCK_RUN_ID },
        createdAt: { gte: new Date(st.at) },
      },
    });
    st.settled = st.reached;
    if (answered > 0) return;

    const level = st.reached >= 2 ? p.targets[st.reached - 2] : p.entryRef;
    if (level === null || level === undefined) {
      this.logger.warn(`[desk-target] ${p.symbol}: target ${st.reached} crossed, no entry reference to lock to — not locked`);
      return;
    }
    if (!isTighter(p.bullish, level, p.stop)) return; // never loosens: the stop in force is already at or past it
    if (!isPaperTracker(p.trackerId) && this.alarms && authorityLive(this.authority) && (await this.lockAlarm(p, level, st.reached, now))) return;
    await this.lock(p, level, st.reached, now);
  }

  /**
   * Trade agent exit authority (spec §4.2 "Desk target-lock"): a live position's lock becomes a TARGET_LOCK alarm
   * to its trade agent instead of a code tighten. false = the alarm could not be raised (the caller locks as today).
   */
  private async lockAlarm(p: ManagedPosition, level: number, reached: number, now: Date): Promise<boolean> {
    const target = p.targets[reached - 1];
    const to = reached >= 2 ? `target ${reached - 1}` : 'entry';
    const reason = `target lock: ${p.underlying} crossed target ${reached} (${target}) and the manager did not act within ${TARGET_LOCK_AFTER_MS / 1000} s — lock the profit: stop to ${to} ${level}`;
    try {
      const row = await (this.alarms as Pick<TradeAlarmsPort, 'raise'>).raise(
        {
          userId: this.cfg.ownerUserId as string,
          trackerId: p.trackerId,
          symbol: p.symbol,
          rule: 'TARGET_LOCK',
          urgency: 'normal',
          reason: reason.slice(0, 500),
          wouldHave: `TIGHTEN ${p.underlying} stop to ${level} (${TARGET_LOCK_RUN_ID})`,
          sourceRef: p.openDecisionId,
          payload: { level, underlying: p.underlying, target, reached, stopInForce: p.stop },
        },
        now,
      );
      this.logger.warn(`[desk-target] TARGET_LOCK alarm ${p.symbol}: ${reason}${row ? ` (alarm ${row.id})` : ' (an open alarm already covers it)'}`);
      return true;
    } catch (err) {
      this.logger.error(`[desk-target] ${p.symbol}: TARGET_LOCK alarm failed (${errText(err)}) — locking by code as before`);
      return false;
    }
  }

  private async lock(p: ManagedPosition, level: number, reached: number, now: Date): Promise<ActionResult> {
    const reason = `target lock: ${p.underlying} crossed target ${reached} (${p.targets[reached - 1]}) and the manager did not act within ${TARGET_LOCK_AFTER_MS / 1000} s — stop to ${reached >= 2 ? `target ${reached - 1}` : 'entry'} ${level}`;
    const payload = { action: 'TIGHTEN', trackerId: p.trackerId, underlyingStop: level, reason, evidence: [`target ${reached} = ${p.targets[reached - 1]}`, `lock level = ${level}`] };
    const row = await this.prisma.deskManagerDecision.create({
      data: {
        runId: TARGET_LOCK_RUN_ID,
        userId: this.cfg.ownerUserId as string,
        action: 'TIGHTEN',
        underlying: p.underlying,
        trackerId: p.trackerId,
        payload: payload as Prisma.InputJsonValue,
        validation: { ok: true, problems: [], source: 'target-lock' } as Prisma.InputJsonValue,
        status: 'VALID',
      },
      select: { id: true },
    });
    const result = await this.exits.tighten(p.trackerId, level, reason, {
      runId: TARGET_LOCK_RUN_ID,
      decisionId: row.id,
      now,
      packet: lockPacket(this.cfg, now, p),
      cfg: this.cfg,
    });
    await this.prisma.deskManagerDecision.update({ where: { id: row.id }, data: { status: result.status, result: result as unknown as Prisma.InputJsonValue } });
    this.logger.warn(`[desk-target] LOCK ${p.symbol}: ${reason} — ${result.status} ${result.detail}`);
    return result;
  }

  /** The manager's still-open positions: DONE OPEN decisions → their tracker / paper trade, with targets and stops. */
  async load(owner: string, now: Date): Promise<ManagedPosition[]> {
    const rows = await this.prisma.deskManagerDecision.findMany({
      where: {
        userId: owner,
        action: { in: ['OPEN', 'TIGHTEN'] },
        status: { in: ['DONE', 'RECORDED'] },
        createdAt: { gte: new Date(now.getTime() - LOOKBACK_MS) },
      },
      orderBy: { createdAt: 'asc' },
    });
    const opens = rows.filter((r) => r.action === 'OPEN');
    if (opens.length === 0) return [];

    // Tracker of each OPEN: its own trackerId, else the live order's tracker, else the paper trade.
    const orderIds = opens.filter((o) => !o.trackerId && o.orderRowId).map((o) => o.orderRowId as string);
    const orders = orderIds.length
      ? await this.prisma.signalOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, trackerId: true } })
      : [];
    const orderTracker = new Map(orders.map((o) => [o.id, o.trackerId]));
    const trackerOf = (o: (typeof opens)[number]): string | null =>
      o.trackerId ?? (o.orderRowId ? (orderTracker.get(o.orderRowId) ?? null) : null) ?? (o.tradeId ? paperTrackerId(o.tradeId) : null);

    const liveIds = opens.map(trackerOf).filter((id): id is string => !!id && !isPaperTracker(id));
    const paperIds = opens.map(trackerOf).filter((id): id is string => !!id && isPaperTracker(id)).map(tradeIdOf);
    type LiveRow = { id: string; symbol: string; exchange: string; qty: number; entryPrice: number };
    type PaperRow = { id: string; status: string; side: string; quantity: number; entryPrice: number | null; instrument: { symbol: string; exchange: string } | null };
    const [trackers, trades]: [LiveRow[], PaperRow[]] = await Promise.all([
      liveIds.length
        ? this.prisma.tradeTracker.findMany({ where: { id: { in: liveIds }, status: 'OPEN' }, select: { id: true, symbol: true, exchange: true, qty: true, entryPrice: true } })
        : Promise.resolve([] as LiveRow[]),
      paperIds.length
        ? this.prisma.trade.findMany({
            where: { id: { in: paperIds } },
            select: { id: true, status: true, side: true, quantity: true, entryPrice: true, instrument: { select: { symbol: true, exchange: true } } },
          })
        : Promise.resolve([] as PaperRow[]),
    ]);
    const live = new Map(trackers.map((t) => [t.id, t]));
    const paper = new Map(trades.filter((t) => OPEN_TRADE.has(String(t.status))).map((t) => [paperTrackerId(t.id), t]));

    const runIds = [...new Set(opens.map((o) => o.runId))];
    const runs = runIds.length
      ? await this.prisma.deskManagerRun.findMany({ where: { id: { in: runIds } }, select: { id: true, packet: true } })
      : [];
    const runPacket = new Map(runs.map((r) => [r.id, r.packet]));

    const out: ManagedPosition[] = [];
    for (const o of opens) {
      const trackerId = trackerOf(o);
      if (!trackerId) continue;
      const d = (o.payload ?? {}) as Record<string, any>;
      const underlying = String(o.underlying ?? d.underlying ?? '').trim().toUpperCase();
      if (!underlying) continue;
      const bullish = d.side !== 'BUY_PE';
      const t = live.get(trackerId);
      const pt = paper.get(trackerId);
      if (!t && !pt) continue; // closed (or never filled)
      const symbol = t?.symbol ?? pt?.instrument?.symbol ?? '';
      const exchange = t?.exchange ?? pt?.instrument?.exchange ?? '';
      const qty = t ? Number(t.qty) : Math.abs(Number(pt?.quantity ?? 0)) * (String(pt?.side).toUpperCase() === 'SELL' ? -1 : 1);
      const entry = Number(t?.entryPrice ?? pt?.entryPrice ?? 0);
      const targets = (Array.isArray(d.targets?.underlying) ? d.targets.underlying : [])
        .map(num)
        .filter((n: number | null): n is number => n !== null)
        .sort((a: number, b: number) => (bullish ? a - b : b - a));
      let stop = num(d.stop?.underlying);
      for (const tr of rows) {
        if (tr.action !== 'TIGHTEN' || tr.trackerId !== trackerId || tr.createdAt < o.createdAt) continue;
        const s = num((tr.payload as Record<string, any> | null)?.underlyingStop);
        if (s !== null && isTighter(bullish, s, stop)) stop = s;
      }
      out.push({
        trackerId,
        openDecisionId: o.id,
        underlying,
        symbol,
        exchange,
        qty,
        entry,
        bullish,
        entryRef: entryRefOf(o.result, d, runPacket.get(o.runId), underlying),
        targets,
        stop,
      });
    }
    return out;
  }
}

/**
 * The underlying at entry: what the OPEN's executor recorded (`result.underlyingEntry`), else the zone mid /
 * breakout trigger, else the instrument LTP in the packet the manager decided on. Null when none is known.
 */
export function entryRefOf(result: unknown, d: Record<string, any>, packet: unknown, underlying: string): number | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const fromResult = num(r.underlyingEntry) ?? num(r.entryUnderlying);
  if (fromResult !== null) return fromResult;
  const e = d.entry ?? {};
  if (e.type === 'ZONE' && num(e.low) !== null && num(e.high) !== null) return (e.low + e.high) / 2;
  if (e.type === 'BREAKOUT') return num(e.triggerAbove) ?? num(e.triggerBelow);
  const inst = (packet as DeskPacket | null | undefined)?.instruments;
  const view = inst?.status === 'present' ? inst.value?.[underlying] : undefined;
  return num(view?.ltp);
}

/** The minimal packet a target lock hands DeskExitActions.tighten: just the one position. */
function lockPacket(cfg: DeskManagerConfig, now: Date, p: ManagedPosition): DeskPacket {
  const none = { status: 'unavailable' as const, reason: 'target lock (no manager run)', source: 'target-watch' };
  const pos: PositionView = {
    trackerId: p.trackerId,
    symbol: p.symbol,
    exchange: p.exchange,
    underlying: p.underlying,
    qty: p.qty,
    entry: p.entry,
    ltp: null,
    pnl: null,
    ageMin: 0,
    origin: 'manager',
    held: false,
    sentinel: null,
    managerStop: p.stop,
    managerTargets: p.targets,
  };
  return {
    at: now.toISOString(),
    mode: cfg.mode,
    day: none,
    pnl: none,
    guard: none,
    positions: { status: 'present', value: [pos], source: 'target-watch' },
    recentExits: none,
    proposals: none,
    instruments: none,
    health: none,
    memory: none,
  };
}
