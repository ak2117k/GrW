import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { contractValueFactor } from '@td/shared';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import type { SetupWatchMarket } from '../../ai-setups/services/setup-watch.service';
import { estimateCharges, segmentFor as chargeSegmentFor } from '../../trade-sentinel/charges';
import { barsWindow, gradeDecision, gradeKindOf, type DeskGrade, type GradeDecisionRow, type GradeInput, type GradeTrade } from '../domain/desk-grade';
import type { Proposal } from '../domain/desk.types';

/** 23:45 IST Mon–Fri, after the MCX close. */
export const DESK_GRADE_CRON = '45 23 * * 1-5';
/**
 * The 15m bar reads the grader needs — the setup watch's market (same loader, same refs). Task 8 binds it with
 * `{ provide: DESK_GRADE_MARKET, useExisting: SETUP_WATCH_MARKET }` (or a fake in specs). Never an order.
 */
export const DESK_GRADE_MARKET = Symbol('DESK_GRADE_MARKET');
export type DeskGradeMarket = Pick<SetupWatchMarket, 'underlyingRef' | 'bars15m'>;
export const DESK_GRADE_NOW = Symbol('DESK_GRADE_NOW');

const LEASE_TTL_MS = 30 * 60_000;
/** Ungraded rows created this far back are (re)tried each night. */
export const DESK_GRADE_LOOKBACK_MS = 7 * 86_400_000;
const BATCH = 500;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PAPER_PREFIX = 'paper:';

export interface DeskGradeRunResult {
  graded: number;
  notReady: number;
  failed: number;
  grades: DeskGrade[];
}

/**
 * Nightly grading of desk-manager decisions (plan 2026-11-26 Task 6; rules in domain/desk-grade.ts).
 * Reads every ungraded decision of the last 7 days, gathers what its kind needs (the trade / position, the
 * underlying's 15m bars, the run packet's proposal, the guard events), and writes `grade` with a conditional
 * update (`where grade is null`) so a re-run or a second instance never overwrites a grade. A decision not ready
 * yet (trade still open, window not over) stays null and is retried the next night. One summary line per run.
 */
@Injectable()
export class DeskGradeCron {
  private readonly logger = new Logger(DeskGradeCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DESK_GRADE_MARKET) private readonly market: DeskGradeMarket,
    @Optional() private readonly lease?: CronLeaseService,
    @Optional() @Inject(DESK_GRADE_NOW) private readonly nowFn?: () => Date,
  ) {}

  @Cron(DESK_GRADE_CRON, { name: 'desk-manager-grade', timeZone: 'Asia/Kolkata' })
  async onNight(): Promise<void> {
    const now = this.nowFn ? this.nowFn() : new Date();
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      const job = () => this.grade(now);
      if (this.lease) await this.lease.runExclusiveFailClosed('desk-manager-grade', LEASE_TTL_MS, job);
      else await job();
    } catch (e) {
      this.logger.warn(`[desk-grade] run failed: ${errText(e)}`);
    }
  }

  /** One grading pass. */
  async grade(now: Date): Promise<DeskGradeRunResult> {
    const rows = (await this.prisma.deskManagerDecision.findMany({
      where: { grade: { equals: Prisma.AnyNull }, createdAt: { gte: new Date(now.getTime() - DESK_GRADE_LOOKBACK_MS), lte: now } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })) as unknown as Array<GradeDecisionRow & { tradeId: string | null; orderRowId: string | null }>;
    const out: DeskGradeRunResult = { graded: 0, notReady: 0, failed: 0, grades: [] };
    for (const row of rows) {
      try {
        const input = await this.inputFor(row, now);
        const grade = gradeDecision(input);
        if (!grade) {
          out.notReady++;
          continue;
        }
        const res = await this.prisma.deskManagerDecision.updateMany({
          where: { id: row.id, grade: { equals: Prisma.AnyNull } },
          data: { grade: grade as unknown as Prisma.InputJsonValue },
        });
        if (res.count === 1) {
          out.graded++;
          out.grades.push(grade);
        }
      } catch (e) {
        out.failed++;
        this.logger.warn(`[desk-grade] ${row.action} ${row.id}: ${errText(e)}`);
      }
    }
    this.logger.log(summaryLine(out));
    return out;
  }

  private async inputFor(row: GradeDecisionRow & { tradeId: string | null; orderRowId: string | null }, now: Date): Promise<GradeInput> {
    const input: GradeInput = { row, now };
    const kind = gradeKindOf(row.action);
    if (kind === 'OPEN') {
      const pending = await this.prisma.deskManagerPendingEntry.findUnique({ where: { decisionId: row.id } });
      input.pendingStatus = pending?.status ?? null;
      const tradeId = row.tradeId ?? pending?.tradeId ?? null;
      const orderRowId = row.orderRowId ?? pending?.orderRowId ?? null;
      let trackerId = row.trackerId;
      if (!trackerId && orderRowId) {
        const order = await this.prisma.signalOrder.findUnique({ where: { id: orderRowId }, select: { trackerId: true } });
        trackerId = order?.trackerId ?? null;
      }
      input.trade = tradeId ? await this.paperTrade(tradeId) : trackerId ? await this.position(trackerId) : null;
      input.underlying = row.underlying;
    } else if (kind === 'EXIT') {
      input.trade = row.trackerId ? await this.position(row.trackerId) : null;
      input.underlying = row.underlying ?? (await this.underlyingOfTracker(row.trackerId));
    } else if (kind === 'NO_ACTION') {
      input.proposal = await this.proposalFor(row);
      input.underlying = row.underlying ?? input.proposal?.underlying ?? null;
    } else if (kind === 'PAUSE') {
      const minutes = isRec(row.payload) && typeof row.payload.minutes === 'number' ? row.payload.minutes : 0;
      const events = await this.prisma.deskGuardEvent.findMany({
        where: { userId: row.userId, blocked: true, at: { gte: row.createdAt, lt: new Date(row.createdAt.getTime() + minutes * 60_000) } },
        select: { at: true, reasons: true },
      });
      input.guardEvents = events;
    }
    const w = barsWindow(input);
    if (w && input.underlying) {
      const b = await this.barsFor(input.underlying, w.from, new Date(Math.min(w.to.getTime(), now.getTime())));
      input.bars = b.bars;
      input.barsError = b.error;
    }
    return input;
  }

  /** A trade_trackers row (live), or the paper trade behind a `paper:<id>` / bare trade id. */
  private async position(id: string): Promise<GradeTrade | null> {
    if (id.startsWith(PAPER_PREFIX)) return this.paperTrade(id.slice(PAPER_PREFIX.length));
    const t = await this.prisma.tradeTracker.findUnique({ where: { id } });
    if (!t) return this.paperTrade(id);
    let charges: number | null = null;
    if (t.exitPrice !== null && t.exitPrice !== undefined) {
      charges = estimateCharges({
        segment: chargeSegmentFor({ exchange: t.exchange, symbol: t.symbol, kind: t.kind }),
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        qty: Math.abs(t.qty),
        side: t.qty < 0 ? 'SHORT' : 'LONG',
        valueFactor: contractValueFactor(t.exchange, t.symbol),
      });
    }
    return { id: t.id, status: t.status, symbol: t.symbol, entryAt: t.entryTime, exitAt: t.exitTime, pnl: t.pnl, charges };
  }

  /** A paper trade: pnl is gross by design, `fees` holds its entry + exit charges. */
  private async paperTrade(id: string): Promise<GradeTrade | null> {
    const t = await this.prisma.trade.findUnique({
      where: { id },
      select: { id: true, status: true, pnl: true, fees: true, entryTime: true, exitTime: true, instrument: { select: { symbol: true } } },
    });
    if (!t) return null;
    return { id: t.id, status: t.status, symbol: t.instrument?.symbol ?? null, entryAt: t.entryTime, exitAt: t.exitTime, pnl: t.pnl, charges: t.fees ?? 0 };
  }

  /** The underlying another decision on the same tracker named (the OPEN carries it). */
  private async underlyingOfTracker(trackerId: string | null): Promise<string | null> {
    if (!trackerId) return null;
    const d = await this.prisma.deskManagerDecision.findFirst({
      where: { trackerId, underlying: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { underlying: true },
    });
    return d?.underlying ?? null;
  }

  /** NO_ACTION: the proposal it names (`proposalRef` in the payload), read from its run's packet. */
  private async proposalFor(row: GradeDecisionRow): Promise<Proposal | null> {
    const ref = isRec(row.payload) && typeof row.payload.proposalRef === 'string' ? row.payload.proposalRef : null;
    if (!ref) return null;
    const run = await this.prisma.deskManagerRun.findUnique({ where: { id: row.runId }, select: { packet: true } });
    const block = isRec(run?.packet) ? run!.packet.proposals : null;
    const list: unknown[] = isRec(block) && block.status === 'present' && Array.isArray(block.value) ? (block.value as unknown[]) : [];
    const p = list.find((x) => isRec(x) && x.ref === ref);
    return (p as Proposal | undefined) ?? null;
  }

  private async barsFor(underlying: string, from: Date, to: Date): Promise<{ bars: Bar15m[] | null; error: string | null }> {
    try {
      const ref = await this.market.underlyingRef(underlying, from);
      if (!ref) return { bars: null, error: `no priced line for ${underlying} in the instrument master` };
      return { bars: await this.market.bars15m(ref, from, to), error: null };
    } catch (e) {
      return { bars: null, error: errText(e) };
    }
  }
}

/** One line per run: counts by kind, OPEN net ₹ and hits, EXIT points saved. */
export function summaryLine(r: DeskGradeRunResult): string {
  const by = (k: string) => r.grades.filter((g) => g.kind === k);
  const opens = by('OPEN');
  const net = opens.reduce((a, g) => a + (g.netPnl ?? 0), 0);
  const exits = by('EXIT');
  const saved = exits.reduce((a, g) => a + (g.vsHold60 ?? 0), 0);
  const hits = (k: string) => opens.filter((g) => g.hit === k).length;
  return (
    `[desk-grade] graded ${r.graded} (OPEN ${opens.length}: net ₹${Math.round(net * 100) / 100}, ${hits('TARGET')} target / ${hits('STOP')} stop; ` +
    `EXIT ${exits.length}: ${Math.round(saved * 100) / 100} pts saved vs hold 60; NO_ACTION ${by('NO_ACTION').length}; PAUSE ${by('PAUSE').length}; OTHER ${by('OTHER').length}); ` +
    `not ready ${r.notReady}; failed ${r.failed}`
  );
}
