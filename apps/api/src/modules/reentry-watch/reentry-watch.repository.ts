import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SIGNAL_PAPER_STRATEGY } from '../signal-trader/domain/paper';
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

/**
 * The re-entry watch's data access. READ-ONLY on everything but reentry_watch_decisions (trades,
 * trade_trackers, instruments). reentry_watch_decisions is written with raw SQL so nothing here depends on a
 * regenerated Prisma client (migration 202611051530_reentry_watch). Instruments are matched by
 * tradingsymbol + exchange, never by token (NSE reuses tokens across expiries).
 */
@Injectable()
export class ReentryWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Option positions exited since `since`: real trade_trackers and the signal-trader / entry-engine paper trades. */
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
    const trackers = await this.prisma.tradeTracker.findMany({
      where: { status: 'CLOSED', kind: 'POSITION', exitTime: { gte: since }, exchange: { in: DERIVATIVE_EXCHANGES } },
      select: { id: true, symbol: true, exchange: true, qty: true, entryTime: true, exitTime: true, exitPrice: true },
      orderBy: { exitTime: 'asc' },
      take: READ_MAX,
    });
    for (const t of trackers) {
      const kind = optionKindOf(t.symbol);
      if (!kind || !t.exitTime) continue;
      out.push({
        refTable: 'trade_trackers', refId: t.id, origin: 'REAL', symbol: t.symbol, exchange: t.exchange,
        underlying: watchUnderlying((await this.instrumentName(t.symbol, t.exchange)) ?? nameFromSymbol(t.symbol)),
        kind, side: t.qty < 0 ? 'SELL' : 'BUY', entryAt: t.entryTime ?? null, exitAt: t.exitTime, exitPrice: t.exitPrice ?? null,
      });
    }
    return out;
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

  /** Open positions on `name`: real OPEN trackers on its contracts + open / pending REENTRY_WATCH paper trades. */
  async openOnUnderlying(name: string): Promise<number> {
    const n = up(name).replace(/[^A-Z0-9]/g, '');
    const pattern = `^${n}[0-9]{2}[A-Z]{3}[0-9]{2}`;
    const real = await this.prisma.$queryRaw<Array<{ n: unknown }>>`
      SELECT COUNT(*)::int AS n FROM "trade_trackers"
      WHERE status = 'OPEN' AND kind = 'POSITION' AND UPPER(symbol) ~ ${pattern}`;
    const paper = await this.prisma.trade.count({
      where: { strategy: REENTRY_STRATEGY, isPaperTrade: true, status: { in: ['OPEN', 'PENDING'] }, instrument: { name: { equals: n, mode: 'insensitive' } } },
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
}
