import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { contractValueFactor } from '@td/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SIGNAL_PAPER_STRATEGY } from '../signal-trader/domain/paper';
import { computeOrderCharges } from '../trade-engine/services/trade-charges';
import { nameFromSymbol, optionKindOf, watchUnderlying, type ExitedPosition } from './domain/reentry-rules';
import { REENTRY_OF_TAG, REENTRY_STRATEGY, type ReentryWatchMode } from './reentry-watch.config';

/** The paper strategies whose exits start a watch (kept literal for ENGINE_ENTRY like signal-trader's paper.ts). */
export const WATCHED_PAPER_STRATEGIES: readonly string[] = [SIGNAL_PAPER_STRATEGY, 'ENGINE_ENTRY'];
const DERIVATIVE_EXCHANGES = ['NFO', 'BFO', 'MCX'];
const READ_MAX = 500;

export interface ReentryDecisionRow {
  id: string;
  watchKey: string;
  underlying: string;
  at: Date;
  action: string;
  direction: string | null;
  category: string;
  inputs: unknown;
  reasons: string[];
  mode: ReentryWatchMode;
}

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();

// ---------------------------------------------------------------------------------------------------------------
// LIVE mode (docs/superpowers/specs/2026-11-23-reentry-live-design.md §4.4, §6a). Everything below is read from the
// DATABASE, never from in-memory maps. The new columns (migration 202611231800_reentry_live) are read / written with
// raw SQL so nothing depends on a regenerated Prisma client.
// ---------------------------------------------------------------------------------------------------------------

/** signal_orders.source of a live re-entry order (the signal trader's own rows default to 'signal'). */
export const REENTRY_ORDER_SOURCE = 'reentry';
/** Statuses of an order that is in flight or holds a position: it COUNTS for every cap (§6a.3). */
export const LIVE_COUNTED_STATUSES: readonly string[] = ['CLAIMED', 'PLACED', 'UNCERTAIN', 'FILLED', 'PARTIAL'];
/** Statuses where the order may still become a position. */
const IN_FLIGHT_STATUSES: readonly string[] = ['CLAIMED', 'PLACED', 'UNCERTAIN'];
const FILLED_STATUSES: readonly string[] = ['FILLED', 'PARTIAL'];

/**
 * Contracts that are the same underlying for "never while the same underlying is open" (§6a.3d). The old
 * `^NAME[0-9]{2}` pattern of openOnUnderlying never matches a mini (GOLD vs GOLDM05DEC26...). Each family lists the
 * full contract and every smaller one (conservative: any of them open blocks a live re-entry on the name).
 */
const FAMILIES: ReadonlyArray<readonly string[]> = [
  ['GOLD', 'GOLDM', 'GOLDPETAL', 'GOLDGUINEA', 'GOLDTEN'],
  ['SILVER', 'SILVERM', 'SILVERMIC', 'SILVER100'],
  ['CRUDEOIL', 'CRUDEOILM'],
  ['NATURALGAS', 'NATGASMINI', 'NATGAS'],
];

/** Every name that counts as `underlying` (its whole family, minis included); just the name outside the families. */
export function underlyingFamily(underlying: string): string[] {
  const n = up(underlying).replace(/[^A-Z0-9]/g, '');
  if (!n) return [];
  return [...(FAMILIES.find((f) => f.includes(n)) ?? [n])];
}

/** Tradingsymbol pattern for a family: one of the names followed by a digit (BANKNIFTY never matches NIFTY). */
export function familyPattern(names: readonly string[]): string {
  return `^(${names.join('|')})[0-9]`;
}

export interface ReentryFillRow {
  side: string;
  exchange: string;
  tradingsymbol: string;
  status: string;
  qty: number | null;
  lots: number | null;
  fillPrice: number | null;
  fillQty: number | null;
}

/**
 * Filled quantity in contract units (lots x master lotSize, the unit of signal_orders.qty). A FILLED order is its own
 * qty; otherwise its fill_qty, scaled up when the venue's order book answered in lots. Null when unreadable.
 */
export function filledUnits(o: Pick<ReentryFillRow, 'status' | 'qty' | 'lots' | 'fillQty'>): number | null {
  const qty = o.qty === null || o.qty === undefined ? NaN : Number(o.qty);
  const okQty = Number.isFinite(qty) && qty > 0;
  if (o.status === 'FILLED' && okQty) return qty;
  const fq = o.fillQty === null || o.fillQty === undefined ? NaN : Number(o.fillQty);
  if (!Number.isFinite(fq) || fq <= 0) return null;
  const lots = o.lots === null || o.lots === undefined ? NaN : Number(o.lots);
  if (okQty && Number.isFinite(lots) && lots > 0 && qty > lots && qty % lots === 0 && fq <= lots) return fq * (qty / lots);
  return okQty ? Math.min(fq, qty) : fq;
}

/**
 * §6a.5: net ₹ P&L of ONE live re-entry from its OWN order fill (entry) and the tracker's exit, minus both legs'
 * charges (trade-charges.ts). Not the tracker's average price (it can mix an earlier same-day round trip).
 * Null when anything needed is unreadable.
 */
export function liveReentryNetPnl(o: ReentryFillRow, exitPrice: number | null): number | null {
  if (o.fillPrice === null || o.fillPrice === undefined || exitPrice === null || exitPrice === undefined) return null;
  const entry = Number(o.fillPrice);
  const exit = Number(exitPrice);
  const units = filledUnits(o);
  const side = up(o.side);
  if (!(entry > 0) || !(exit > 0) || units === null || !(units > 0)) return null;
  if (side !== 'BUY' && side !== 'SELL') return null;
  const factor = contractValueFactor(o.exchange, o.tradingsymbol);
  const gross = (side === 'BUY' ? exit - entry : entry - exit) * units * factor;
  const exitSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';
  const charges =
    computeOrderCharges({ side, price: entry, quantity: units, exchange: o.exchange, symbol: o.tradingsymbol }).total +
    computeOrderCharges({ side: exitSide, price: exit, quantity: units, exchange: o.exchange, symbol: o.tradingsymbol }).total;
  return Math.round((gross - charges) * 100) / 100;
}

/** A closed live re-entry is a loss for #7 when its net P&L < 0 — or when it cannot be read (unreadable ⇒ the safe side). */
export function isLiveLoss(o: ReentryFillRow, exitPrice: number | null): boolean {
  const pnl = liveReentryNetPnl(o, exitPrice);
  return pnl === null || pnl < 0;
}

/** Postgres "undefined column" (42703): the reentry_live migration is not applied yet. */
export function isMissingColumn(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.meta?.code === '42703' || e.code === '42703') return true;
  return /column .* does not exist/i.test(String(e.meta?.message ?? e.message ?? ''));
}

export interface LiveCounts {
  /** Re-entries of this watch: live orders in flight / filled + paper re-entries (§6a.3a/b). */
  reentriesOfWatch: number;
  /** Live re-entry orders today, in flight or filled (§6a.3c). */
  liveToday: number;
  /** Closed live re-entries today with net P&L < 0, or unreadable (§6a.5). */
  liveLossesToday: number;
  /**
   * §6a.3d: the latest exit among this watch's CLOSED live re-entry trackers (linked by signal_orders.tracker_id), so
   * live re-entries count for the 10-minute cooldown — reentriesOf() sees only the paper re-entries' exits.
   * Null / absent = none closed yet.
   */
  lastLiveExitAt?: Date | null;
}

export interface LiveDecisionRow {
  watchKey: string;
  underlying: string;
  at: Date;
  direction: string;
  mode: 'live' | 'paper';
  /** The ReentryLiveLimit that kept a live-eligible signal off the broker (null when it went live). */
  limit: string | null;
  detail: string | null;
  signalOrderId?: string | null;
  tradeId?: string | null;
  inputs: unknown;
  reasons: unknown;
}

/** A live re-entry order to resume after a restart (SignalExecutorService.resume's row shape). */
export interface PendingReentryOrder {
  id: string;
  brokerOrderId: string;
  orderTag: string;
  userId: string;
  exchange: string;
  token: string;
  tradingsymbol: string;
  side: string;
  qty: number;
  lots: number | null;
  limitPrice: number;
  sl: number;
  targets: unknown;
}

const n0 = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The re-entry watch's data access. READ-ONLY on everything but reentry_watch_decisions (trades,
 * trade_trackers, instruments, signal_orders). reentry_watch_decisions is written with raw SQL so nothing here
 * depends on a regenerated Prisma client (migrations 202611051530_reentry_watch, 202611231800_reentry_live).
 * Instruments are matched by tradingsymbol + exchange, never by token (NSE reuses tokens across expiries).
 */
@Injectable()
export class ReentryWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Option positions exited since `since`: real trade_trackers and the signal-trader / entry-engine paper trades.
   * Trackers that are themselves live re-entries are left out (§4.4 / §6a.2: never a chain).
   */
  async exitsSince(since: Date): Promise<ExitedPosition[]> {
    const paper = await this.prisma.trade.findMany({
      where: { isPaperTrade: true, status: 'CLOSED', strategy: { in: [...WATCHED_PAPER_STRATEGIES] }, exitTime: { gte: since } },
      select: { id: true, side: true, entryTime: true, exitTime: true, exitPrice: true, strategy: true, instrument: { select: { symbol: true, exchange: true, name: true } } },
      orderBy: { exitTime: 'asc' },
      take: READ_MAX,
    });
    const out: ExitedPosition[] = [];
    for (const t of paper) {
      const kind = optionKindOf(t.instrument.symbol);
      if (!kind || !t.exitTime) continue;
      out.push({
        refTable: 'trades', refId: t.id, origin: t.strategy === 'ENGINE_ENTRY' ? 'ENGINE_PAPER' : 'SIGNAL_PAPER',
        symbol: t.instrument.symbol, exchange: t.instrument.exchange, underlying: watchUnderlying(up(t.instrument.name) || nameFromSymbol(t.instrument.symbol)),
        kind, side: up(t.side) === 'SELL' ? 'SELL' : 'BUY', entryAt: t.entryTime ?? null, exitAt: t.exitTime, exitPrice: t.exitPrice ?? null,
      });
    }
    // Every user's closed trackers are still watched (paper behaviour unchanged since 2026-11-05); the tracker's userId
    // is carried so only the signal trader's OWNER can re-enter LIVE (the service checks it — review fix 2026-11-23:
    // without it another user's exit would have traded the owner's account).
    const trackers = await this.prisma.tradeTracker.findMany({
      where: { status: 'CLOSED', kind: 'POSITION', exitTime: { gte: since }, exchange: { in: DERIVATIVE_EXCHANGES } },
      select: { id: true, userId: true, symbol: true, exchange: true, qty: true, entryTime: true, exitTime: true, exitPrice: true },
      orderBy: { exitTime: 'asc' },
      take: READ_MAX,
    });
    const liveReentry = await this.liveReentryTrackerIds(trackers.map((t) => t.id));
    for (const t of trackers) {
      const kind = optionKindOf(t.symbol);
      if (!kind || !t.exitTime) continue;
      if (liveReentry.has(t.id)) continue;
      out.push({
        refTable: 'trade_trackers', refId: t.id, origin: 'REAL', symbol: t.symbol, exchange: t.exchange,
        underlying: watchUnderlying((await this.instrumentName(t.symbol, t.exchange)) ?? nameFromSymbol(t.symbol)),
        kind, side: t.qty < 0 ? 'SELL' : 'BUY', entryAt: t.entryTime ?? null, exitAt: t.exitTime, exitPrice: t.exitPrice ?? null,
        userId: t.userId ?? null,
      });
    }
    return out;
  }

  /**
   * Trackers (of `ids`) that are themselves live re-entries: linked through signal_orders.tracker_id to a
   * source='reentry' order — or, when that link is missing (a NO_TRACKER hand-off), on the token of a re-entry order
   * that may hold a position, sent between 15 min before the tracker's entry and its exit (conservative: at worst a
   * real exit goes unwatched). Before the migration there is no source column, hence no live re-entry order:
   * nothing to exclude, and the paper watch reads exactly as before. Any other read error is thrown.
   */
  async liveReentryTrackerIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT t.id AS id FROM "trade_trackers" t
        JOIN "signal_orders" o ON o.source = ${REENTRY_ORDER_SOURCE} AND (
          o.tracker_id = t.id
          OR (o.tracker_id IS NULL AND o.token = t.token AND o.status = ANY(${[...LIVE_COUNTED_STATUSES]}::text[])
              AND o.created_at >= (t."entryTime" AT TIME ZONE 'UTC') - interval '15 minutes'
              AND o.created_at <= COALESCE(t."exitTime" AT TIME ZONE 'UTC', now()))
        )
        WHERE t.id = ANY(${ids}::text[])`;
      return new Set(rows.map((r) => String(r.id)));
    } catch (err) {
      if (isMissingColumn(err)) return new Set();
      throw err;
    }
  }

  /** The instrument's name by tradingsymbol + exchange (never by token). */
  async instrumentName(symbol: string, exchange: string): Promise<string | null> {
    const r = await this.prisma.instrument.findFirst({ where: { symbol, exchange }, select: { name: true } });
    return r?.name ? up(r.name) : null;
  }

  /** Re-entries of one watch (any status) and the latest exit among them. */
  async reentriesOf(watchKey: string): Promise<{ count: number; lastExitAt: Date | null }> {
    const rows = await this.prisma.trade.findMany({
      where: { strategy: REENTRY_STRATEGY, isPaperTrade: true, entryTags: { has: `${REENTRY_OF_TAG}${watchKey}` } },
      select: { exitTime: true },
    });
    const exits = rows.map((r) => r.exitTime).filter((d): d is Date => d instanceof Date);
    return { count: rows.length, lastExitAt: exits.length ? new Date(Math.max(...exits.map((d) => d.getTime()))) : null };
  }

  /** REENTRY_WATCH trades created since `since` (today's count). */
  reentriesSince(since: Date): Promise<number> {
    return this.prisma.trade.count({ where: { strategy: REENTRY_STRATEGY, isPaperTrade: true, createdAt: { gte: since } } });
  }

  /**
   * Open positions on `name`: real OPEN trackers on its contracts + open / pending REENTRY_WATCH paper trades. The
   * parent and its MCX minis are one underlying (GOLD / GOLDM, CRUDEOIL / CRUDEOILM — review fix 2026-11-23: a GOLDM
   * exit is watched on GOLD, so an open GOLDM must hold a GOLD re-entry). Outside the MCX families: just the name.
   */
  async openOnUnderlying(name: string): Promise<number> {
    const n = up(name).replace(/[^A-Z0-9]/g, '');
    const names = underlyingFamily(n);
    const pattern = `^(${(names.length ? names : [n]).join('|')})[0-9]{2}[A-Z]{3}[0-9]{2}`;
    const real = await this.prisma.$queryRaw<Array<{ n: unknown }>>`
      SELECT COUNT(*)::int AS n FROM "trade_trackers"
      WHERE status = 'OPEN' AND kind = 'POSITION' AND UPPER(symbol) ~ ${pattern}`;
    const paper = await this.prisma.trade.count({
      where: {
        strategy: REENTRY_STRATEGY, isPaperTrade: true, status: { in: ['OPEN', 'PENDING'] },
        OR: (names.length ? names : [n]).map((x) => ({ instrument: { name: { equals: x, mode: 'insensitive' as const } } })),
      },
    });
    return Number(real[0]?.n ?? 0) + paper;
  }

  async insertDecision(r: ReentryDecisionRow): Promise<void> {
    const inputs = JSON.stringify(r.inputs ?? {});
    const reasons = JSON.stringify(r.reasons ?? []);
    await this.prisma.$executeRaw`
      INSERT INTO "reentry_watch_decisions" ("id", "watch_key", "underlying", "at", "action", "direction", "category", "inputs", "reasons", "mode")
      VALUES (${r.id}, ${r.watchKey}, ${r.underlying}, ${r.at}, ${r.action}, ${r.direction}, ${r.category}, ${inputs}::jsonb, ${reasons}::jsonb, ${r.mode})`;
  }

  /** The paper trade a SIGNAL opened (or why not): trade id, the plan, and the reasons line appended. */
  async settleDecision(id: string, tradeId: string | null, note: string, plan: unknown): Promise<void> {
    const extra = JSON.stringify([note]);
    const planJson = JSON.stringify({ plan: plan ?? null });
    await this.prisma.$executeRaw`
      UPDATE "reentry_watch_decisions" SET "trade_id" = ${tradeId}, "reasons" = "reasons" || ${extra}::jsonb, "inputs" = "inputs" || ${planJson}::jsonb WHERE id = ${id}`;
  }

  // ---- LIVE mode: counts (DB only), the same-underlying check, decision rows ----

  /**
   * §6a.3: the caps' counts, from the DATABASE only. A live order counts while CLAIMED / PLACED / UNCERTAIN / FILLED
   * / PARTIAL (or whenever it has a fill); REJECTED / CANCELLED / FAILED never became a position (a paper fallback
   * that followed is counted as the paper re-entry it opened). reentriesOfWatch is not limited to today (a watch
   * lives one day; counting all is the safe side). Throws when anything cannot be read — the caller then passes
   * null to the gate (UNKNOWN_INPUT ⇒ paper).
   */
  async liveCountsFor(watchKey: string, dayStartUtc: Date): Promise<LiveCounts> {
    const counted = [...LIVE_COUNTED_STATUSES];
    const [ofWatch, today, paper, closed, lastExit] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: unknown }>>`
        SELECT COUNT(*)::int AS n FROM "signal_orders"
        WHERE source = ${REENTRY_ORDER_SOURCE} AND reentry_watch_key = ${watchKey}
          AND (status = ANY(${counted}::text[]) OR COALESCE(fill_qty, 0) > 0)`,
      this.prisma.$queryRaw<Array<{ n: unknown }>>`
        SELECT COUNT(*)::int AS n FROM "signal_orders"
        WHERE source = ${REENTRY_ORDER_SOURCE} AND created_at >= ${dayStartUtc}
          AND (status = ANY(${counted}::text[]) OR COALESCE(fill_qty, 0) > 0)`,
      this.prisma.trade.count({ where: { strategy: REENTRY_STRATEGY, isPaperTrade: true, entryTags: { has: `${REENTRY_OF_TAG}${watchKey}` } } }),
      // The order ↔ tracker link: signal_orders.tracker_id, or — when the hand-off found no tracker (NO_TRACKER, link
      // NULL) — the same fallback liveReentryTrackerIds uses: same user + token, a counted status, sent between 15 min
      // before the tracker's entry and its exit (review fix 2026-11-23: an inner join on tracker_id alone never
      // counted such a re-entry as a loss / exit). DISTINCT ON: one row per order (the direct link first).
      this.prisma.$queryRaw<
        Array<{ side: string; exchange: string; tradingsymbol: string; status: string; qty: unknown; lots: unknown; fill_price: unknown; fill_qty: unknown; exit_price: unknown }>
      >`
        SELECT DISTINCT ON (o.id) o.side, o.exchange, o.tradingsymbol, o.status, o.qty, o.lots, o.fill_price, o.fill_qty, t."exitPrice" AS exit_price
        FROM "signal_orders" o JOIN "trade_trackers" t ON (
          o.tracker_id = t.id
          OR (o.tracker_id IS NULL AND o.token = t.token AND o.user_id = t."userId" AND o.status = ANY(${counted}::text[])
              AND o.created_at >= (t."entryTime" AT TIME ZONE 'UTC') - interval '15 minutes'
              AND o.created_at <= COALESCE(t."exitTime" AT TIME ZONE 'UTC', now()))
        )
        WHERE o.source = ${REENTRY_ORDER_SOURCE} AND o.created_at >= ${dayStartUtc} AND t.status = 'CLOSED'
        ORDER BY o.id, (o.tracker_id = t.id) DESC NULLS LAST, t."exitTime" DESC`,
      this.prisma.$queryRaw<Array<{ last_exit: unknown }>>`
        SELECT MAX(t."exitTime") AS last_exit
        FROM "signal_orders" o JOIN "trade_trackers" t ON (
          o.tracker_id = t.id
          OR (o.tracker_id IS NULL AND o.token = t.token AND o.user_id = t."userId" AND o.status = ANY(${counted}::text[])
              AND o.created_at >= (t."entryTime" AT TIME ZONE 'UTC') - interval '15 minutes'
              AND o.created_at <= COALESCE(t."exitTime" AT TIME ZONE 'UTC', now()))
        )
        WHERE o.source = ${REENTRY_ORDER_SOURCE} AND o.reentry_watch_key = ${watchKey} AND t.status = 'CLOSED'`,
    ]);
    const lastRaw = Array.isArray(lastExit) ? lastExit[0]?.last_exit : null;
    const lastMs = lastRaw instanceof Date ? lastRaw.getTime() : lastRaw ? new Date(String(lastRaw)).getTime() : NaN;
    const lastLiveExitAt = Number.isFinite(lastMs) ? new Date(lastMs) : null;
    const liveLossesToday = closed.filter((r) =>
      isLiveLoss(
        {
          side: r.side, exchange: r.exchange, tradingsymbol: r.tradingsymbol, status: r.status,
          qty: numOrNull(r.qty), lots: numOrNull(r.lots), fillPrice: numOrNull(r.fill_price), fillQty: numOrNull(r.fill_qty),
        },
        numOrNull(r.exit_price),
      ),
    ).length;
    return { reentriesOfWatch: n0(ofWatch[0]?.n) + paper, liveToday: n0(today[0]?.n), liveLossesToday, lastLiveExitAt };
  }

  /**
   * §6a.3d: is anything open or about to be on `underlying` (its whole family, minis included)? Real OPEN position
   * trackers (by tradingsymbol pattern OR the master's name), signal_orders of ANY source created today that are in
   * flight (CLAIMED / PLACED / UNCERTAIN) or filled with no tracker linked yet, and open / pending REENTRY_WATCH
   * paper trades. Throws when unreadable (caller ⇒ null ⇒ paper).
   */
  async underlyingOpenOrInFlight(underlying: string, dayStartUtc: Date): Promise<boolean> {
    const names = underlyingFamily(underlying);
    if (names.length === 0) throw new Error(`underlyingOpenOrInFlight: unreadable underlying "${underlying}"`);
    const pattern = familyPattern(names);
    const [real, orders, paper] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: unknown }>>`
        SELECT COUNT(*)::int AS n FROM "trade_trackers" t
        WHERE t.status = 'OPEN' AND t.kind = 'POSITION' AND (
          UPPER(t.symbol) ~ ${pattern}
          OR EXISTS (SELECT 1 FROM "instruments" i WHERE i.symbol = t.symbol AND i.exchange = t.exchange AND UPPER(i.name) = ANY(${names}::text[]))
        )`,
      this.prisma.$queryRaw<Array<{ n: unknown }>>`
        SELECT COUNT(*)::int AS n FROM "signal_orders" o
        WHERE o.created_at >= ${dayStartUtc} AND UPPER(o.tradingsymbol) ~ ${pattern}
          AND (o.status = ANY(${[...IN_FLIGHT_STATUSES]}::text[]) OR (o.status = ANY(${[...FILLED_STATUSES]}::text[]) AND o.tracker_id IS NULL))`,
      this.prisma.trade.count({
        where: {
          strategy: REENTRY_STRATEGY, isPaperTrade: true, status: { in: ['OPEN', 'PENDING'] },
          OR: names.map((name) => ({ instrument: { name: { equals: name, mode: 'insensitive' as const } } })),
        },
      }),
    ]);
    return n0(real[0]?.n) + n0(orders[0]?.n) + paper > 0;
  }

  /**
   * Restart recovery (review fix 2026-11-23): today's live re-entry orders (source 'reentry') in `statuses`, in the
   * shape SignalExecutorService.resume takes. An order with no broker order id (an UNCERTAIN send) is followed by its
   * ordertag (`tag:<tag>` — the executor then reads the book by tag and never cancels). Before the reentry_live
   * migration there is no source column, hence no such order: []. Any other read error is thrown.
   */
  async pendingLiveReentryOrders(dayStartUtc: Date, statuses: readonly string[]): Promise<PendingReentryOrder[]> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string; broker_order_id: string | null; order_tag: string; user_id: string; exchange: string; token: string; tradingsymbol: string;
          side: string; qty: unknown; lots: unknown; limit_price: unknown; sl: unknown; targets: unknown;
        }>
      >`
        SELECT id, broker_order_id, order_tag, user_id, exchange, token, tradingsymbol, side, qty, lots, limit_price, sl, targets
        FROM "signal_orders"
        WHERE source = ${REENTRY_ORDER_SOURCE} AND created_at >= ${dayStartUtc} AND status = ANY(${[...statuses]}::text[])
        ORDER BY created_at ASC`;
      return rows.map((r) => ({
        id: String(r.id),
        brokerOrderId: r.broker_order_id ? String(r.broker_order_id) : `tag:${r.order_tag}`,
        orderTag: String(r.order_tag),
        userId: String(r.user_id),
        exchange: String(r.exchange),
        token: String(r.token),
        tradingsymbol: String(r.tradingsymbol),
        side: String(r.side),
        qty: n0(r.qty),
        lots: numOrNull(r.lots),
        limitPrice: n0(r.limit_price),
        sl: n0(r.sl),
        targets: r.targets,
      }));
    } catch (err) {
      if (isMissingColumn(err)) return [];
      throw err;
    }
  }

  /** One live-mode SIGNAL decision (live, or paper with the limit that stopped it). Returns the new row's id. */
  async recordLiveDecision(r: LiveDecisionRow): Promise<string> {
    const id = randomUUID();
    const inputs = JSON.stringify(r.inputs ?? {});
    const reasons = JSON.stringify(Array.isArray(r.reasons) ? r.reasons : r.reasons === undefined || r.reasons === null ? [] : [r.reasons]);
    const dir = String(r.direction ?? '').toLowerCase();
    const category = r.mode === 'live' ? `${dir}-live` : `${dir}-paper-${String(r.limit ?? 'none').toLowerCase()}`;
    await this.prisma.$executeRaw`
      INSERT INTO "reentry_watch_decisions" ("id", "watch_key", "underlying", "at", "action", "direction", "category", "inputs", "reasons", "mode", "trade_id", "limit_hit", "limit_detail", "signal_order_id")
      VALUES (${id}, ${r.watchKey}, ${r.underlying}, ${r.at}, 'SIGNAL', ${r.direction}, ${category}, ${inputs}::jsonb, ${reasons}::jsonb, ${r.mode},
              ${r.tradeId ?? null}, ${r.limit}, ${r.detail}, ${r.signalOrderId ?? null})`;
    return id;
  }

  /**
   * The outcome of a recorded live decision once known (the order row, a paper fallback trade, a limit hit after the
   * gate such as a funds reject). Only the fields given non-null are set; `note` is appended to reasons.
   */
  async settleLiveDecision(
    id: string,
    p: { signalOrderId?: string | null; tradeId?: string | null; mode?: 'live' | 'paper'; limit?: string | null; detail?: string | null; note?: string | null },
  ): Promise<void> {
    const extra = JSON.stringify(p.note ? [p.note] : []);
    await this.prisma.$executeRaw`
      UPDATE "reentry_watch_decisions" SET
        "signal_order_id" = COALESCE(${p.signalOrderId ?? null}, "signal_order_id"),
        "trade_id" = COALESCE(${p.tradeId ?? null}, "trade_id"),
        "mode" = COALESCE(${p.mode ?? null}, "mode"),
        "limit_hit" = COALESCE(${p.limit ?? null}, "limit_hit"),
        "limit_detail" = COALESCE(${p.detail ?? null}, "limit_detail"),
        "reasons" = "reasons" || ${extra}::jsonb
      WHERE id = ${id}`;
  }
}
