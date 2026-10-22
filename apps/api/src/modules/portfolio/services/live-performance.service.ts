import { Injectable } from '@nestjs/common';
import {
  LiveTradesRepository,
  type LiveExitRow,
  type LiveOrderRow,
  type LiveTrackerRow,
} from '../repositories/live-trades.repository';
import { triggerOf } from '../../sentinel-executor/domain/manual-exit';

/**
 * LIVE (real-money) performance for the Dashboard and the Journal's Live tab.
 *
 * Source of truth = trade_trackers: one row per real Angel One position/holding,
 * whichever way it was opened (the owner at the broker, the app's manual-trade
 * page, or the model/auto-trade). Its pnl is rupees ((exit|ltp − entry) × signed qty).
 * Attribution is layered on top:
 *   - closedBy: a live ai_exit_executions row for the tracker (PLACED/FILLED) says
 *     the app closed it — AI verdict → AGENT, owner's "Exit now" → MANUAL, a price
 *     trigger → TRIGGER. A live trades row the model closed → MODEL. Otherwise the
 *     position vanished from the broker book on its own → MANUAL (at the broker).
 *   - openedBy: a live trades row (isPaperTrade=false) on the same token that was
 *     created inside the tracker's window → MODEL (or MANUAL when its source is the
 *     manual-trade page). Otherwise MANUAL.
 * Live trades rows that match no tracker are listed on their own so nothing is lost;
 * a matched row is never counted twice.
 *
 * Days are IST calendar days (DB timestamps are UTC).
 */

export type LiveSegment = 'OPTIONS' | 'FUTURES' | 'EQUITY' | 'COMMODITY' | 'CURRENCY';
export type ClosedBy = 'AGENT' | 'MANUAL' | 'TRIGGER' | 'MODEL';
export type OpenedBy = 'MANUAL' | 'MODEL';

export interface LiveTradeRow {
  id: string;
  origin: 'TRACKER' | 'ORDER';
  symbol: string;
  exchange: string;
  segment: LiveSegment;
  kind: string; // POSITION | HOLDING | ORDER
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  ltp: number | null;
  entryTime: string;
  exitTime: string | null;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  pnlPercent: number | null;
  openedBy: OpenedBy;
  closedBy: ClosedBy | null;
  strategy: string | null;
  /** Why the app closed it (the verdict / trigger reason), when it did. */
  closeNote: string | null;
}

export interface LiveSummary {
  realisedPnl: number;
  todayRealisedPnl: number;
  unrealisedPnl: number;
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0..100
  maxDrawdown: number; // rupees, peak-to-trough of the realised equity curve
}

export interface LiveDashboard {
  summary: LiveSummary;
  equityCurve: Array<{ date: string; equity: number }>;
  dailyPnl: Array<{ date: string; pnl: number }>;
  segments: Array<{ segment: string; pnl: number; trades: number; wins: number; losses: number }>;
  closedBy: Array<{ closedBy: ClosedBy; trades: number; pnl: number }>;
  recent: LiveTradeRow[];
  asOf: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' of the IST calendar day containing `d`. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function classifySegment(exchange: string, symbol: string): LiveSegment {
  const ex = String(exchange ?? '').toUpperCase();
  const sym = String(symbol ?? '').toUpperCase();
  if (ex === 'MCX' || ex === 'NCDEX') return 'COMMODITY';
  if (ex === 'CDS') return 'CURRENCY';
  if (ex === 'NFO' || ex === 'BFO') {
    if (/FUT/.test(sym)) return 'FUTURES';
    return 'OPTIONS';
  }
  return 'EQUITY';
}

function closedByOfExit(exit: LiveExitRow): ClosedBy {
  const t = triggerOf(exit.verdictId);
  return t === 'AI' ? 'AGENT' : t === 'MANUAL' ? 'MANUAL' : 'TRIGGER';
}

const openedByOfOrder = (o: LiveOrderRow): OpenedBy =>
  String(o.source ?? '').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'MODEL';

const orderTime = (o: LiveOrderRow): Date => o.entryTime ?? o.createdAt;

/** Does live order `o` belong to tracker `t`? Same token, created inside the tracker's life (1 day grace before). */
function orderMatchesTracker(o: LiveOrderRow, t: LiveTrackerRow): boolean {
  if (!o.instrument || String(o.instrument.token) !== String(t.token)) return false;
  const at = orderTime(o).getTime();
  const from = t.entryTime.getTime() - DAY_MS;
  const to = t.exitTime ? t.exitTime.getTime() : Number.POSITIVE_INFINITY;
  return at >= from && at <= to;
}

/** Merge trackers + live exit rows + live trades rows into one list of real trades. */
export function buildLiveTrades(
  trackers: LiveTrackerRow[],
  exits: LiveExitRow[],
  orders: LiveOrderRow[],
): LiveTradeRow[] {
  // Latest live exit per tracker (rows arrive oldest first; FILLED beats PLACED).
  const exitByTracker = new Map<string, LiveExitRow>();
  for (const e of exits) {
    const prev = exitByTracker.get(e.trackerId);
    if (!prev || e.status === 'FILLED' || prev.status !== 'FILLED') exitByTracker.set(e.trackerId, e);
  }

  const usedOrders = new Set<string>();
  const rows: LiveTradeRow[] = [];

  for (const t of trackers) {
    const order = orders.find((o) => !usedOrders.has(o.id) && orderMatchesTracker(o, t)) ?? null;
    if (order) usedOrders.add(order.id);
    const closed = t.status === 'CLOSED';
    const exit = exitByTracker.get(t.id) ?? null;

    let closedBy: ClosedBy | null = null;
    let closeNote: string | null = null;
    if (closed) {
      if (exit) {
        closedBy = closedByOfExit(exit);
        closeNote = exit.verdictReason ?? null;
      } else if (order && order.exitTime && openedByOfOrder(order) === 'MODEL') {
        closedBy = 'MODEL';
      } else {
        closedBy = 'MANUAL';
      }
    }

    const qty = Number(t.qty) || 0;
    rows.push({
      id: t.id,
      origin: 'TRACKER',
      symbol: t.symbol,
      exchange: t.exchange,
      segment: classifySegment(t.exchange, t.symbol),
      kind: t.kind,
      side: qty < 0 ? 'SHORT' : 'LONG',
      qty: Math.abs(qty),
      entryPrice: t.entryPrice ?? null,
      exitPrice: closed ? (t.exitPrice ?? null) : null,
      ltp: t.lastLtp ?? null,
      entryTime: t.entryTime.toISOString(),
      exitTime: closed && t.exitTime ? t.exitTime.toISOString() : null,
      status: closed ? 'CLOSED' : 'OPEN',
      pnl: round2(Number(t.pnl ?? 0)),
      pnlPercent: t.pnlPercent ?? null,
      openedBy: order ? openedByOfOrder(order) : 'MANUAL',
      closedBy,
      strategy: order?.strategy ?? null,
      closeNote,
    });
  }

  for (const o of orders) {
    if (usedOrders.has(o.id)) continue;
    const closed = o.status === 'CLOSED';
    const symbol = o.instrument?.symbol ?? 'Unknown';
    const exchange = o.instrument?.exchange ?? '';
    const openedBy = openedByOfOrder(o);
    rows.push({
      id: o.id,
      origin: 'ORDER',
      symbol,
      exchange,
      segment: classifySegment(exchange, symbol),
      kind: 'ORDER',
      side: String(o.side).toUpperCase() === 'SELL' ? 'SHORT' : 'LONG',
      qty: o.quantity,
      entryPrice: o.entryPrice ?? null,
      exitPrice: closed ? (o.exitPrice ?? null) : null,
      ltp: null,
      entryTime: orderTime(o).toISOString(),
      exitTime: closed && o.exitTime ? o.exitTime.toISOString() : null,
      status: closed ? 'CLOSED' : 'OPEN',
      pnl: round2(Number(o.pnl ?? 0)),
      pnlPercent: o.pnlPercent ?? null,
      openedBy,
      closedBy: closed ? (openedBy === 'MODEL' ? 'MODEL' : 'MANUAL') : null,
      strategy: o.strategy ?? null,
      closeNote: null,
    });
  }

  // Newest activity first (exit time for closed rows, entry for open ones).
  const activity = (r: LiveTradeRow) => Date.parse(r.exitTime ?? r.entryTime);
  return rows.sort((a, b) => activity(b) - activity(a));
}

/** Aggregate the merged live trades into the Dashboard's widgets. */
export function buildLiveDashboard(rows: LiveTradeRow[], now: Date, recentLimit = 8): LiveDashboard {
  const today = istDay(now);
  const closed = rows.filter((r) => r.status === 'CLOSED' && r.exitTime);
  const open = rows.filter((r) => r.status === 'OPEN');

  const byDay = new Map<string, number>();
  for (const r of closed) {
    const d = istDay(new Date(r.exitTime as string));
    byDay.set(d, (byDay.get(d) ?? 0) + r.pnl);
  }
  const days = [...byDay.keys()].sort();
  const dailyPnl = days.map((date) => ({ date, pnl: round2(byDay.get(date) ?? 0) }));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve = dailyPnl.map(({ date, pnl }) => {
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    return { date, equity: round2(cumulative) };
  });

  const segMap = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();
  const closerMap = new Map<ClosedBy, { trades: number; pnl: number }>();
  let wins = 0;
  let losses = 0;
  for (const r of closed) {
    if (r.pnl > 0) wins += 1;
    else if (r.pnl < 0) losses += 1;
    const s = segMap.get(r.segment) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
    s.pnl += r.pnl;
    s.trades += 1;
    if (r.pnl > 0) s.wins += 1;
    else if (r.pnl < 0) s.losses += 1;
    segMap.set(r.segment, s);
    if (r.closedBy) {
      const c = closerMap.get(r.closedBy) ?? { trades: 0, pnl: 0 };
      c.trades += 1;
      c.pnl += r.pnl;
      closerMap.set(r.closedBy, c);
    }
  }

  const realisedPnl = closed.reduce((s, r) => s + r.pnl, 0);
  return {
    summary: {
      realisedPnl: round2(realisedPnl),
      todayRealisedPnl: round2(byDay.get(today) ?? 0),
      unrealisedPnl: round2(open.reduce((s, r) => s + r.pnl, 0)),
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses,
      winRate: closed.length > 0 ? round2((wins / closed.length) * 100) : 0,
      maxDrawdown: round2(maxDrawdown),
    },
    equityCurve,
    dailyPnl,
    segments: [...segMap.entries()].map(([segment, s]) => ({ segment, ...s, pnl: round2(s.pnl) })),
    closedBy: [...closerMap.entries()].map(([closedBy, c]) => ({ closedBy, trades: c.trades, pnl: round2(c.pnl) })),
    recent: rows.slice(0, recentLimit),
    asOf: now.toISOString(),
  };
}

@Injectable()
export class LivePerformanceService {
  constructor(private readonly repo: LiveTradesRepository) {}

  async listLiveTrades(userId: string): Promise<LiveTradeRow[]> {
    const [trackers, exits, orders] = await Promise.all([
      this.repo.listTrackers(userId),
      this.repo.listLiveExits(userId),
      this.repo.listLiveOrders(userId),
    ]);
    return buildLiveTrades(trackers, exits, orders);
  }

  async getDashboard(userId: string, now: Date = new Date()): Promise<LiveDashboard> {
    return buildLiveDashboard(await this.listLiveTrades(userId), now);
  }
}
