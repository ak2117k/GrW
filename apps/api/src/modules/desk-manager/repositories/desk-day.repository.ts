import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { istDayStart } from '../../signal-trader/domain/execution';
import { istDay, underlyingOf } from '../../portfolio-review/domain/symbols';
import type { ClosedTrade, DayPnlPath, TradeOrigin } from '../domain/desk.types';
import { carriedTodayPnl, type GuardOpenTrade } from '../domain/pnl-path';
import { inVenueSession } from '../../exit-discipline/session-bars';

/** The guard's stored day state, already scoped to today (a row from another IST day reads as empty). */
export interface GuardDayState {
  pausedUntil: Date | null;
  pauseScope: string | null;
  resetAt: Date | null;
}

const EMPTY: GuardDayState = { pausedUntil: null, pauseScope: null, resetAt: null };

/** signal_orders.source of an app order → the trade's origin (an unrecognised source is 'unknown', still counted). */
function originOf(source: string): TradeOrigin {
  if (source === 'signal' || source === 'reentry' || source === 'manager') return source;
  return 'unknown';
}

/** signal_orders statuses that can stand behind a live position. */
const LIVE_ORDER_STATUSES = ['FILLED', 'PARTIAL', 'UNCERTAIN'] as const;
const ORDER_LOOKBACK_MS = 7 * 86_400_000;
/** A linked tracker that CLOSED this close to (or after) the unlinked tracker's open is treated as re-created. */
const RECREATE_SLACK_MS = 15 * 60_000;

/** A live tracker as {@link originsOf} needs it. */
export interface OriginTrackerRow {
  id: string;
  symbol: string;
  exchange: string | null;
  token: string | null;
  entryTime: Date | null;
  exitTime?: Date | null;
}

/**
 * tracker id → origin (+ the app order's desk decision id). THE ONE origin classifier: the desk guard
 * (DeskDayRepository) and the packet's positions block (DeskStateRepository.openPositions) both use it, so a
 * position is never "manual" in one and "manager" in the other (final review 2026-11-28, item 4).
 * 'manual' ONLY on positive evidence that no app order is behind the position (a real-money guard must not let an app
 * trade escape as "manual"):
 *  1. a signal_orders row linked by trackerId → its source (oldest row wins; a null source = the signal trader);
 *  2. otherwise (the executor's NO_TRACKER branch, the window before linking, a re-created tracker) any of the
 *     user's live-status app orders (FILLED / PARTIAL / UNCERTAIN, last 7 days, created before the tracker
 *     closed) for the same contract — exchange+token or tradingsymbol — that is still open: never linked, linked
 *     to a tracker that no longer exists, or linked to a CLOSED tracker that closed at/after this tracker opened
 *     (−15 min: a reconcile re-created it). An order still serving ANOTHER open tracker is that tracker's, not
 *     this one's. Any match ⇒ that order's source;
 *  3. no match ⇒ absent from the map ('manual' to the caller).
 * Every app path that trades live money (signal trader, reentry, desk manager OPEN) writes a signal_orders row,
 * so this one table is the evidence for all of them.
 */
export async function originsOf(
  prisma: PrismaService,
  userId: string,
  rows: OriginTrackerRow[],
  now: Date,
): Promise<Map<string, { origin: TradeOrigin; decisionId: string | null }>> {
  const out = new Map<string, { origin: TradeOrigin; decisionId: string | null }>();
  if (rows.length === 0) return out;
  const linked = await prisma.signalOrder.findMany({
    where: { trackerId: { in: rows.map((r) => r.id) } },
    select: { trackerId: true, source: true, decisionId: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const o of linked) {
    if (o.trackerId && !out.has(o.trackerId)) out.set(o.trackerId, { origin: originOf(o.source ?? 'signal'), decisionId: o.decisionId ?? null });
  }
  const unlinked = rows.filter((r) => !out.has(r.id));
  if (unlinked.length === 0) return out;

  const tokens = [...new Set(unlinked.map((r) => r.token).filter((t): t is string => !!t))];
  const symbols = [...new Set(unlinked.map((r) => r.symbol).filter(Boolean))];
  const cands = await prisma.signalOrder.findMany({
    where: {
      userId,
      status: { in: [...LIVE_ORDER_STATUSES] },
      createdAt: { gte: new Date(now.getTime() - ORDER_LOOKBACK_MS) },
      OR: [{ token: { in: tokens } }, { tradingsymbol: { in: symbols } }],
    },
    select: { trackerId: true, source: true, decisionId: true, exchange: true, token: true, tradingsymbol: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (cands.length === 0) return out;
  const linkedIds = [...new Set(cands.map((c) => c.trackerId).filter((t): t is string => !!t))];
  const trackerOf = new Map<string, { status: string; exitTime: Date | null }>();
  if (linkedIds.length > 0) {
    const ts = await prisma.tradeTracker.findMany({ where: { userId, id: { in: linkedIds } }, select: { id: true, status: true, exitTime: true } });
    for (const t of ts) trackerOf.set(t.id, { status: t.status, exitTime: t.exitTime ?? null });
  }
  for (const r of unlinked) {
    const until = (r.exitTime ?? now).getTime();
    const opened = r.entryTime ? r.entryTime.getTime() : 0;
    const hit = cands.find((c) => {
      const same = (!!r.token && c.token === r.token && (!r.exchange || c.exchange === r.exchange)) || c.tradingsymbol === r.symbol;
      if (!same || c.createdAt.getTime() > until) return false;
      if (!c.trackerId) return true;
      const t = trackerOf.get(c.trackerId);
      if (!t) return true; // linked tracker row is gone (re-created)
      if (t.status === 'OPEN') return false; // still serving another open position
      return t.exitTime !== null && t.exitTime.getTime() >= opened - RECREATE_SLACK_MS;
    });
    if (hit) out.set(r.id, { origin: originOf(hit.source ?? 'signal'), decisionId: hit.decisionId ?? null });
  }
  return out;
}

/**
 * The desk guard's reads and writes (plan Task 1). Reads EVERY live position tracker (IST day, NSE + MCX) with its
 * origin; which ones the guard counts is decided in guardDayPath (the app's own trades, not the owner's manual or
 * held ones — supreme fixes W1, 2026-11-28). Never read: paper trades (`paper:` ids live in `trades`, never here), delivery HOLDING
 * rows (not day trades), and anything closed before the owner's reset today.
 */
@Injectable()
export class DeskDayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async closedToday(userId: string, now: Date): Promise<ClosedTrade[]> {
    const dayStart = istDayStart(now);
    const { resetAt } = await this.guardDay(userId, now);
    const from = resetAt && resetAt.getTime() > dayStart.getTime() ? resetAt : dayStart;
    const rows = await this.prisma.tradeTracker.findMany({
      where: {
        userId,
        kind: 'POSITION',
        status: 'CLOSED',
        exitTime: { gte: from, lte: now },
        NOT: { id: { startsWith: 'paper:' } },
      },
      select: { id: true, symbol: true, exchange: true, token: true, entryTime: true, entryPrice: true, exitPrice: true, qty: true, exitTime: true, pnl: true },
      orderBy: { exitTime: 'asc' },
    });
    if (rows.length === 0) return [];
    const originBy = await this.originsOf(userId, rows, now);
    return rows.map((r) => ({
      trackerId: r.id,
      symbol: r.symbol,
      underlying: underlyingOf(r.symbol) || null,
      exitAt: r.exitTime as Date,
      // A closed row without a stored pnl is priced from its exit (value factor 1) — never silently 0, which
      // would end a loss streak.
      pnl: Number.isFinite(r.pnl) ? (r.pnl as number) : r.exitPrice != null ? (r.exitPrice - r.entryPrice) * r.qty : 0,
      origin: originBy.get(r.id) ?? 'manual',
    }));
  }

  /**
   * The owner's open live position trackers (kind POSITION, non-paper) with their origin, the since-entry pnl
   * (the positions-block value) and TODAY's P&L for the day guard: a tracker opened today counts its whole marked
   * pnl; one carried in from an earlier IST day counts only its move since the previous session's close
   * (carriedTodayPnl). The close is the last in-session candles_1m bar before today (session-only read). The
   * guard decides which of them count (guardDayPath).
   */
  async openTrades(userId: string, now: Date): Promise<GuardOpenTrade[]> {
    const dayStart = istDayStart(now);
    const rows = await this.prisma.tradeTracker.findMany({
      where: { userId, kind: 'POSITION', status: 'OPEN', NOT: { id: { startsWith: 'paper:' } } },
      select: { id: true, symbol: true, exchange: true, token: true, entryPrice: true, entryTime: true, qty: true, pnl: true, lastLtp: true },
    });
    if (rows.length === 0) return [];
    const originBy = await this.originsOf(userId, rows, now);
    const out: GuardOpenTrade[] = [];
    for (const r of rows) {
      const stored = typeof r.pnl === 'number' && Number.isFinite(r.pnl) ? r.pnl : null;
      const pnl = stored ?? 0;
      let todayPnl = pnl;
      if (r.entryTime && r.entryTime.getTime() < dayStart.getTime()) {
        const prevClose = await this.prevSessionClose(r.exchange, r.token, dayStart).catch(() => null);
        todayPnl = carriedTodayPnl({ pnl, entryPrice: r.entryPrice, ltp: r.lastLtp ?? null, qty: r.qty, prevClose });
      }
      out.push({ trackerId: r.id, symbol: r.symbol, pnl: stored, todayPnl, origin: originBy.get(r.id) ?? 'manual' });
    }
    return out;
  }

  /** The last in-session 1-minute close strictly before `dayStart` (within 7 days); null when none is stored. */
  private async prevSessionClose(exchange: string | null, token: string | null, dayStart: Date): Promise<number | null> {
    if (!exchange || !token) return null;
    const since = new Date(dayStart.getTime() - 7 * 86_400_000);
    const bars = await this.prisma.$queryRaw<Array<{ ts: Date; close: number }>>`
      SELECT ts, close FROM candles_1m
      WHERE exchange = ${exchange} AND token = ${token} AND ts >= ${since} AND ts < ${dayStart}
      ORDER BY ts DESC LIMIT 2000`;
    for (const b of bars) {
      const ts = b.ts instanceof Date ? b.ts.getTime() : new Date(b.ts).getTime();
      if (inVenueSession(ts, exchange) && Number.isFinite(Number(b.close))) return Number(b.close);
    }
    return null;
  }

  /** tracker id → origin, by the shared {@link originsOf} (no entry ⇒ 'manual' at the call sites). */
  private async originsOf(
    userId: string,
    rows: OriginTrackerRow[],
    now: Date,
  ): Promise<Map<string, TradeOrigin>> {
    const found = await originsOf(this.prisma, userId, rows, now);
    return new Map([...found].map(([id, o]) => [id, o.origin]));
  }

  /** Today's pause / reset (a row left from an earlier IST day is ignored). */
  async guardDay(userId: string, now: Date): Promise<GuardDayState> {
    const row = await this.prisma.deskGuardState.findUnique({ where: { userId } });
    if (!row || row.day !== istDay(now)) return { ...EMPTY };
    return { pausedUntil: row.pausedUntil ?? null, pauseScope: row.pauseScope ?? null, resetAt: row.resetAt ?? null };
  }

  /** Writes today's pause; a new day starts clean (no reset carried over). */
  async savePause(userId: string, now: Date, until: Date | null, scope: string | null): Promise<void> {
    const day = istDay(now);
    const prev = await this.guardDay(userId, now);
    await this.prisma.deskGuardState.upsert({
      where: { userId },
      create: { userId, day, pausedUntil: until, pauseScope: scope, resetAt: null },
      update: { day, pausedUntil: until, pauseScope: scope, resetAt: prev.resetAt },
    });
  }

  /** The owner's reset: trades closed before `now` stop counting today, and any pause is cleared. */
  async saveReset(userId: string, now: Date): Promise<void> {
    const day = istDay(now);
    await this.prisma.deskGuardState.upsert({
      where: { userId },
      create: { userId, day, pausedUntil: null, pauseScope: null, resetAt: now },
      update: { day, pausedUntil: null, pauseScope: null, resetAt: now },
    });
  }

  async recordEvent(e: { userId: string; at: Date; source: string; blocked: boolean; reasons: string[]; path: DayPnlPath | null }): Promise<void> {
    await this.prisma.deskGuardEvent.create({
      data: {
        userId: e.userId,
        at: e.at,
        source: e.source,
        blocked: e.blocked,
        reasons: e.reasons as Prisma.InputJsonValue,
        path: (e.path ?? {}) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
