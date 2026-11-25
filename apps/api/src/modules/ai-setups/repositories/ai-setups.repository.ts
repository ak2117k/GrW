import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ENGINE_UNDERLYING_TAG } from '../../entry-engine/entry-engine.config';
import { PAPER_WATCH_STRATEGIES } from '../../signal-trader/domain/paper';
import type { GradeRow, GradeTrade } from '../domain/setup-grade';
import type { SetupPacketSources } from '../services/setup-packet.service';

/** One ai_setups row as the setup service writes it. */
export interface AiSetupWrite {
  readingId: string;
  underlying: string;
  channelId: string;
  /** NO_TRADE | SETUP (the AI's own decision) | SKIPPED (no AI decision: a guard, an error). */
  decision: string;
  reason: string;
  setup?: unknown;
  checks?: unknown;
  packet?: unknown;
  /** NO_TRADE | PENDING | SKIPPED (this service never writes the later states). */
  status: string;
  validUntil?: Date | null;
}

/** The paper trades' Trade.strategy (also in signal-trader PAPER_WATCH_STRATEGIES: the paper watch + paper sentinel manage them too). */
export const AI_SETUP_STRATEGY = 'AI_SETUP';
export const AI_SETUP_SOURCE = 'ai-setup';
export const AI_SETUP_TAG = 'ai-setup';
/** The paper trade's tag naming its ai_setups row. */
export const setupTag = (setupId: string) => `setup:${setupId}`;

/** One PENDING / FILLED row as the setup watch reads it. */
export interface ActiveSetupRow {
  id: string;
  underlying: string;
  status: string;
  setup: unknown;
  tradeId: string | null;
  validUntil: Date | null;
  createdAt: Date;
  entryAt: Date | null;
}

/** The setup's paper trade. */
export interface SetupTradeRow {
  id: string;
  status: string;
  strategy: string | null;
  isPaperTrade: boolean;
  exitReasonTag: string | null;
  pnl: number | null;
  exitTime: Date | null;
  entryPrice: number | null;
  instrument: { token: string; exchange: string; symbol: string } | null;
}

/** An ungraded / pending-grade row as the nightly grader reads it (updatedAt guards the conditional write). */
export interface GradeCandidateRow extends GradeRow {
  updatedAt: Date;
}

/** Row statuses that count as an AI setup made (the daily cap); a NO_TRADE or a SKIPPED never counts. */
export const COUNTED_SETUP_STATUSES: readonly string[] = ['PENDING', 'FILLED', 'EXITED', 'EXPIRED'];
/** Setups still in play on their underlying (block another setup on it). */
export const LIVE_SETUP_STATUSES: readonly string[] = ['PENDING', 'FILLED'];

/** IST midnight that starts now's IST day (UTC instant). Local copy: this module imports no signal-trader order code. */
export function istDayStart(now: Date): Date {
  const off = 330 * 60_000;
  const d = new Date(now.getTime() + off);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off);
}

/** The first `byChannel` object anywhere in a self-review summary (as the signal judge reads it). */
export function findByChannel(summary: unknown, depth = 0): Record<string, unknown> | null {
  if (!summary || typeof summary !== 'object' || depth > 4) return null;
  const o = summary as Record<string, unknown>;
  if (o.byChannel && typeof o.byChannel === 'object' && !Array.isArray(o.byChannel)) return o.byChannel as Record<string, unknown>;
  for (const v of Object.values(o)) {
    const hit = findByChannel(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const json = (v: unknown) => (v === undefined || v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A broker symbol on `u`: the bare name, its -EQ cash line, or a dated derivative (DABUR29DEC25430CE, CRUDEOIL19DEC25FUT). */
const symbolOf = (u: string) => new RegExp(`^${escapeRe(u)}(-EQ$|\\d{2}[A-Z]{3}\\d{2}|$)`, 'i');

/**
 * ai_setups storage, the setup guards' reads (trades / trade_trackers / signal_decisions / ai_setups) and the
 * setup packet's two database sources (channel record, today's desk). Read-only outside ai_setups.
 */
@Injectable()
export class AiSetupsRepository implements SetupPacketSources {
  constructor(private readonly prisma: PrismaService) {}

  async insert(r: AiSetupWrite): Promise<void> {
    await this.prisma.aiSetup.create({
      data: {
        readingId: r.readingId,
        underlying: r.underlying,
        channelId: r.channelId,
        decision: r.decision,
        reason: r.reason.slice(0, 2_000),
        setup: json(r.setup),
        checks: json(r.checks),
        packet: json(r.packet),
        status: r.status,
        validUntil: r.validUntil ?? null,
      },
    });
  }

  /** AI setups made today (IST): PENDING / FILLED / EXITED / EXPIRED rows — from the DB, never from memory. */
  setupsToday(now: Date): Promise<number> {
    return this.prisma.aiSetup.count({ where: { status: { in: [...COUNTED_SETUP_STATUSES] }, createdAt: { gte: istDayStart(now) } } });
  }

  /** Every ai_setups row on `underlying` since `since` (the cooldown; the caller decides which rows count). */
  recentOnUnderlying(underlying: string, since: Date): Promise<Array<{ status: string; checks: unknown; createdAt: Date }>> {
    return this.prisma.aiSetup.findMany({
      where: { underlying, createdAt: { gte: since } },
      select: { status: true, checks: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Why no setup may be built on `underlying` now, or null: another AI setup PENDING / FILLED on it; an open or
   * resting signal / engine / re-entry paper trade, or any open real-money trade, on it (trades table); a live
   * position on it (trade_trackers, kind POSITION — long-term holdings do not block an intraday option); or a
   * signal trigger armed on it today (signal_decisions decision PENDING).
   */
  async openOnUnderlying(underlying: string, now: Date): Promise<string | null> {
    const u = underlying.trim().toUpperCase();
    const re = symbolOf(u);
    const [setup, trades, trackers, armed] = await Promise.all([
      this.prisma.aiSetup.findFirst({ where: { underlying: u, status: { in: [...LIVE_SETUP_STATUSES] } }, select: { id: true, status: true } }),
      this.prisma.trade.findMany({
        where: {
          status: { in: ['OPEN', 'PENDING'] },
          AND: [
            { OR: [{ isPaperTrade: false }, { strategy: { in: [...PAPER_WATCH_STRATEGIES] } }] },
            { OR: [{ instrument: { name: u } }, { instrument: { symbol: { startsWith: u } } }, { entryTags: { has: `${ENGINE_UNDERLYING_TAG}${u}` } }] },
          ],
        },
        select: { id: true, status: true, strategy: true, isPaperTrade: true, entryTags: true, instrument: { select: { name: true, symbol: true } } },
        take: 20,
      }),
      this.prisma.tradeTracker.findMany({ where: { status: 'OPEN', kind: 'POSITION', symbol: { startsWith: u } }, select: { symbol: true }, take: 20 }),
      this.prisma.signalDecision.findFirst({ where: { underlying: u, decision: 'PENDING', createdAt: { gte: istDayStart(now) } }, select: { id: true } }),
    ]);
    if (setup) return `another AI setup is ${setup.status} on ${u} (${setup.id})`;
    const trade = trades.find(
      (t) => String(t.instrument?.name ?? '').toUpperCase() === u || re.test(t.instrument?.symbol ?? '') || t.entryTags.includes(`${ENGINE_UNDERLYING_TAG}${u}`),
    );
    if (trade) {
      return `open signal trade on ${u}: ${trade.isPaperTrade ? 'paper' : 'live'} ${trade.strategy ?? 'trade'} ${trade.instrument?.symbol ?? ''} ${trade.status} (${trade.id})`.replace(/\s+/g, ' ');
    }
    const pos = trackers.find((t) => re.test(t.symbol));
    if (pos) return `open live position on ${u}: ${pos.symbol}`;
    if (armed) return `a signal trigger is armed on ${u} (decision ${armed.id})`;
    return null;
  }

  // ---- The setup watch (services/setup-watch.service.ts): state lives here only; every transition is a
  // ---- conditional updateMany on the row's status, so a double pass or a restart never opens / closes twice.

  /** PENDING / FILLED setups, oldest first (≤ 3 a day). */
  activeSetups(): Promise<ActiveSetupRow[]> {
    return this.prisma.aiSetup.findMany({
      where: { status: { in: [...LIVE_SETUP_STATUSES] } },
      select: { id: true, underlying: true, status: true, setup: true, tradeId: true, validUntil: true, createdAt: true, entryAt: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }) as Promise<ActiveSetupRow[]>;
  }

  /** One row's current status and trade (the watch re-reads it when an attach fails). */
  setupState(id: string): Promise<{ status: string; tradeId: string | null } | null> {
    return this.prisma.aiSetup.findUnique({ where: { id }, select: { status: true, tradeId: true } });
  }

  /** PENDING → FILLED (the claim, before the paper open). False = another pass already moved it. */
  async claimFill(id: string, at: Date): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FILLED', entryAt: at } });
    return r.count === 1;
  }

  /** The claimed FILLED row gets its paper trade (only while it has none) and its watch state. */
  async attachTrade(id: string, tradeId: string, setup: unknown): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({ where: { id, status: 'FILLED', tradeId: null }, data: { tradeId, setup: json(setup) } });
    return r.count === 1;
  }

  /**
   * A claimed FILLED row whose paper open failed (no trade) → EXPIRED with the reason ("OPEN_FAILED: …"), visible and
   * never stuck. EXPIRED, not SKIPPED: the AI did make this setup, so it still counts toward the daily cap.
   */
  async failOpen(id: string, reason: string, at: Date): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({
      where: { id, status: 'FILLED', tradeId: null },
      data: { status: 'EXPIRED', exitReason: reason.slice(0, 500), exitAt: at },
    });
    return r.count === 1;
  }

  /** PENDING → EXPIRED with the reason (validUntil passed, SL crossed before the entry, unreadable setup). */
  async expire(id: string, reason: string, at: Date): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED', exitReason: reason.slice(0, 500), exitAt: at } });
    return r.count === 1;
  }

  /** A FILLED row's watch state (the trailed SL) — written into setup.watch. */
  async saveWatch(id: string, setup: unknown): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({ where: { id, status: 'FILLED' }, data: { setup: json(setup) } });
    return r.count === 1;
  }

  /** FILLED → EXITED with the exit reason and the Trade row's P&L. */
  async markExited(id: string, e: { exitReason: string; exitAt: Date; pnl: number | null }): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({
      where: { id, status: 'FILLED' },
      data: { status: 'EXITED', exitReason: e.exitReason.slice(0, 500), exitAt: e.exitAt, pnl: e.pnl },
    });
    return r.count === 1;
  }

  /** The setup's paper trade as the watch needs it (status, who closed it, P&L, the contract). */
  setupTrade(tradeId: string): Promise<SetupTradeRow | null> {
    return this.prisma.trade.findUnique({
      where: { id: tradeId },
      select: {
        id: true, status: true, strategy: true, isPaperTrade: true, exitReasonTag: true, pnl: true, exitTime: true, entryPrice: true,
        instrument: { select: { token: true, exchange: true, symbol: true } },
      },
    }) as Promise<SetupTradeRow | null>;
  }

  /** A paper trade already tagged for this setup (restart between the claim and the attach). */
  tradeForSetup(setupId: string): Promise<{ id: string; status: string; entryPrice: number | null } | null> {
    return this.prisma.trade.findFirst({
      where: { strategy: AI_SETUP_STRATEGY, isPaperTrade: true, entryTags: { has: setupTag(setupId) } },
      select: { id: true, status: true, entryPrice: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---- The nightly grader (services/setup-grade.cron.ts). ----

  /**
   * SETUP / NO_TRADE rows created in [since, until) with no grade yet or a PENDING one, oldest first. GRADED and
   * UNGRADABLE rows are never selected again (re-running never double-grades); SKIPPED rows are never graded.
   */
  gradeCandidates(since: Date, until: Date): Promise<GradeCandidateRow[]> {
    return this.prisma.aiSetup.findMany({
      where: {
        decision: { in: ['SETUP', 'NO_TRADE'] },
        status: { not: 'SKIPPED' },
        createdAt: { gte: since, lt: until },
        OR: [{ grade: { equals: Prisma.AnyNull } }, { grade: { path: ['status'], equals: 'PENDING' } }],
      },
      select: {
        id: true, underlying: true, decision: true, status: true, setup: true, checks: true, packet: true, tradeId: true,
        validUntil: true, createdAt: true, exitReason: true, pnl: true, grade: true, updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }) as Promise<GradeCandidateRow[]>;
  }

  /** Writes the grade only if the row is unchanged since it was read (false = changed meanwhile; retried next run). */
  async writeGrade(id: string, readUpdatedAt: Date, grade: unknown): Promise<boolean> {
    const r = await this.prisma.aiSetup.updateMany({ where: { id, updatedAt: readUpdatedAt }, data: { grade: json(grade) } });
    return r.count === 1;
  }

  /** The setup's paper trade for its actual result (pnl is gross; fees hold the paper charges). */
  gradeTrade(tradeId: string): Promise<GradeTrade | null> {
    return this.prisma.trade.findUnique({
      where: { id: tradeId },
      select: { id: true, status: true, pnl: true, fees: true, exitReasonTag: true, isPaperTrade: true },
    });
  }

  /** Every GRADED SETUP grade (the running totals toward the live gate). */
  async gradedSetupGrades(): Promise<unknown[]> {
    const rows = await this.prisma.aiSetup.findMany({
      where: { decision: 'SETUP', status: { not: 'NO_TRADE' }, grade: { path: ['status'], equals: 'GRADED' } },
      select: { grade: true },
      take: 5_000,
    });
    return rows.map((r) => r.grade);
  }

  async channelTitle(channelId: string): Promise<string | null> {
    const r = await this.prisma.telegramChannel.findUnique({ where: { id: channelId }, select: { title: true, username: true } });
    return r?.title || r?.username || null;
  }

  /** The channel's rolling call / claim record from the newest DONE self-review run (its byChannel entry). */
  async channelRecord(channelId: string): Promise<unknown | null> {
    const run = await this.prisma.selfReviewRun.findFirst({ where: { status: 'DONE' }, orderBy: { startedAt: 'desc' }, select: { summary: true, startedAt: true } });
    const v = findByChannel(run?.summary ?? null)?.[channelId];
    return v && typeof v === 'object' ? { asOf: run?.startedAt?.toISOString() ?? null, ...(v as Record<string, unknown>) } : null;
  }

  /**
   * Today's desk (IST `sessionDate`): AI setups made today, the setups still in play, and the open signal /
   * engine / re-entry paper trades and real-money trades (any underlying), so the model sees what is already on.
   * The packet service adds the ₹ ceiling and the daily cap; the option lot size is in the chain block.
   */
  async deskToday(sessionDate: string, underlying: string): Promise<{ setupsToday: number; openTrades: unknown[] } & Record<string, unknown>> {
    const dayStart = new Date(`${sessionDate}T00:00:00+05:30`);
    const [setupsToday, live, trades] = await Promise.all([
      this.prisma.aiSetup.count({ where: { status: { in: [...COUNTED_SETUP_STATUSES] }, createdAt: { gte: dayStart } } }),
      this.prisma.aiSetup.findMany({ where: { status: { in: [...LIVE_SETUP_STATUSES] } }, select: { underlying: true, status: true, validUntil: true }, take: 20 }),
      this.prisma.trade.findMany({
        where: { status: 'OPEN', OR: [{ isPaperTrade: false }, { strategy: { in: [...PAPER_WATCH_STRATEGIES] } }] },
        select: { side: true, isPaperTrade: true, strategy: true, quantity: true, entryPrice: true, instrument: { select: { symbol: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      underlying,
      setupsToday,
      openSetups: live.map((s) => ({ underlying: s.underlying, status: s.status, validUntil: s.validUntil?.toISOString() ?? null })),
      openTrades: trades.map((t) => ({
        symbol: t.instrument?.symbol ?? null,
        underlying: t.instrument?.name ?? null,
        side: t.side,
        paper: t.isPaperTrade,
        strategy: t.strategy,
        quantity: t.quantity,
        entryPrice: t.entryPrice,
      })),
    };
  }
}
