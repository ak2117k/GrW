import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AiExitAuditReader } from './ai-exit-audit.reader';
import type {
  AiExitRecordRow,
  AiExitRow,
  ClosedTradeRow,
  NoiseFollowRow,
  PaperFillRow,
  PaperOpenRow,
  Severity,
} from '../domain/checks';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The paper path's strategy tag for Telegram-signal paper trades (trades.source 'telegram-signal / no-funds'). */
const SIGNAL_PAPER_STRATEGY = 'TELEGRAM_SIGNAL_NO_FUNDS';

export interface ViolationRow {
  id: string;
  check: string;
  subjectId: string;
  severity: string;
  detail: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  alertedAt: Date | null;
}

/**
 * The sanity audit's data access. READ-ONLY on every table but sanity_violations (trades, instruments,
 * trade_events, signal_decisions, paper_sentinel_looks, sentinel_verdicts, AI exit executions (via AiExitAuditReader),
 * exit_noise_reads, oi_snapshots, self_review_runs). Raw SQL throughout so nothing depends on a
 * regenerated Prisma client. trades / oi_snapshots / AI exit timestamps are UTC without zone.
 */
@Injectable()
export class SanityAuditRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exits: AiExitAuditReader,
  ) {}

  /** Telegram-signal paper trades opened since `from`, with the plan LTP of the decision that opened them. */
  async paperFills(from: Date): Promise<PaperFillRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; symbol: string; side: string; entry: unknown; ltp: unknown; created: Date }>>`
      SELECT t.id, i.symbol, t.side, t."entryPrice" AS entry, d.plan->>'ltp' AS ltp, t."createdAt" AS created
      FROM "trades" t
      JOIN "instruments" i ON i.id = t."instrumentId"
      JOIN "signal_decisions" d ON d.plan->'paper'->>'tradeId' = t.id AND d.decided_at >= ${new Date(from.getTime() - 86_400_000)}
      WHERE t.strategy = ${SIGNAL_PAPER_STRATEGY} AND t."isPaperTrade" = true AND t."createdAt" >= ${from}`;
    return rows.map((r) => ({ tradeId: r.id, symbol: r.symbol, side: r.side, entryPrice: num(r.entry), planLtp: num(r.ltp), openedAt: r.created }));
  }

  /** Trades CLOSED since `from`, with their PARTIAL_EXIT event count. */
  async closedTrades(from: Date): Promise<ClosedTradeRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; symbol: string; side: string; quantity: number; entry: unknown; exit: unknown; pnl: unknown; exit_time: Date; partials: bigint | number }>>`
      SELECT t.id, i.symbol, t.side, t.quantity, t."entryPrice" AS entry, t."exitPrice" AS exit, t.pnl, t."exitTime" AS exit_time,
        (SELECT count(*) FROM "trade_events" e WHERE e."tradeId" = t.id AND e."eventType"::text = 'PARTIAL_EXIT') AS partials
      FROM "trades" t JOIN "instruments" i ON i.id = t."instrumentId"
      WHERE t.status = 'CLOSED' AND t."exitTime" >= ${from}`;
    return rows.map((r) => ({
      tradeId: r.id, symbol: r.symbol, side: r.side, quantity: Number(r.quantity), entryPrice: num(r.entry), exitPrice: num(r.exit),
      pnl: num(r.pnl), exitAt: r.exit_time, partialExits: Number(r.partials),
    }));
  }

  /** Paper AI exits (trades AI_EXIT) and real filled AI exits since `from`, each with the newest sentinel look before it. */
  async aiExits(from: Date): Promise<AiExitRow[]> {
    const paper = await this.prisma.$queryRaw<Array<{ id: string; symbol: string; exit: unknown; exit_time: Date; notes: string | null; look_ltp: unknown; look_at: Date | null }>>`
      SELECT t.id, i.symbol, t."exitPrice" AS exit, t."exitTime" AS exit_time, t."exitNotes" AS notes,
        l.packet->'position'->>'ltp' AS look_ltp, l."createdAt" AS look_at
      FROM "trades" t JOIN "instruments" i ON i.id = t."instrumentId"
      LEFT JOIN LATERAL (
        SELECT p.packet, p."createdAt" FROM "paper_sentinel_looks" p
        WHERE p."tradeId" = t.id AND p."createdAt" <= t."exitTime" ORDER BY p."createdAt" DESC LIMIT 1
      ) l ON true
      WHERE t."exitReasonTag" = 'AI_EXIT' AND t.status = 'CLOSED' AND t."exitTime" >= ${from}`;
    const real = await this.exits.filledExits(from);
    return [
      ...paper.map((r): AiExitRow => ({ subjectId: r.id, kind: 'paper', symbol: r.symbol, exitPrice: num(r.exit), exitAt: r.exit_time, notes: r.notes, lookLtp: num(r.look_ltp), lookAt: r.look_at })),
      ...real.map((r): AiExitRow => ({ subjectId: r.id, kind: 'real', symbol: r.symbol, exitPrice: num(r.fill), exitAt: r.at, notes: null, lookLtp: num(r.look_ltp), lookAt: r.look_at })),
    ];
  }

  /** Signal decisions that opened a paper trade since `from`, with their OI check presence. */
  async paperOpens(from: Date): Promise<PaperOpenRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; trade_id: string; symbol: string | null; opened: string | null; decided_at: Date; has_oi: boolean; oi_at: string | null }>>`
      SELECT d.id, d.plan->'paper'->>'tradeId' AS trade_id, d.plan->>'tradingsymbol' AS symbol, d.plan->'paper'->>'at' AS opened,
        d.decided_at, (d.oi_check IS NOT NULL) AS has_oi, d.oi_check->>'at' AS oi_at
      FROM "signal_decisions" d
      WHERE d.plan->'paper'->>'tradeId' IS NOT NULL AND d.decided_at >= ${from}`;
    return rows.map((r) => ({
      decisionId: r.id, tradeId: r.trade_id, symbol: r.symbol, openedAt: date(r.opened) ?? r.decided_at, hasOiCheck: r.has_oi, oiCheckAt: date(r.oi_at),
    }));
  }

  /** AI exits since `from` — paper closes and real executions that read — each with its noise read's write time. */
  async aiExitRecords(from: Date): Promise<AiExitRecordRow[]> {
    const paper = await this.prisma.$queryRaw<Array<{ id: string; symbol: string; exit_time: Date; read_at: Date | null }>>`
      SELECT t.id, i.symbol, t."exitTime" AS exit_time,
        (SELECT min(n.created_at) FROM "exit_noise_reads" n WHERE n.trade_id = t.id OR (n.ref_id = t.id AND n.source <> 'real')) AS read_at
      FROM "trades" t JOIN "instruments" i ON i.id = t."instrumentId"
      WHERE t."exitReasonTag" = 'AI_EXIT' AND t.status = 'CLOSED' AND t."exitTime" >= ${from}`;
    const real = await this.exits.exitRecords(from);
    return [
      ...paper.map((r): AiExitRecordRow => ({ subjectId: r.id, kind: 'paper', symbol: r.symbol, exitAt: r.exit_time, readAt: r.read_at })),
      ...real.map((r): AiExitRecordRow => ({ subjectId: r.id, kind: 'real', symbol: r.symbol, exitAt: r.at, readAt: r.read_at })),
    ];
  }

  /** Newest NFO OI snapshot, and newest NFO futures snapshot carrying an ltp, in the last hour. */
  async nfoOiBeat(now: Date): Promise<{ lastAny: Date | null; lastFutLtp: Date | null }> {
    const rows = await this.prisma.$queryRaw<Array<{ last_any: Date | null; last_fut: Date | null }>>`
      SELECT max(o."timestamp") AS last_any,
        max(o."timestamp") FILTER (WHERE o.ltp IS NOT NULL AND i."optionType" IS NULL) AS last_fut
      FROM "oi_snapshots" o JOIN "instruments" i ON i.id = o."instrumentId"
      WHERE i.segment = 'NFO' AND o."timestamp" >= ${new Date(now.getTime() - 3_600_000)} AND o."timestamp" <= ${new Date(now.getTime() + 60_000)}`;
    return { lastAny: rows[0]?.last_any ?? null, lastFutLtp: rows[0]?.last_fut ?? null };
  }

  /** Exit noise reads exited in [from, before] whose underlying +30 min is still empty. */
  async unfilledNoiseFollows(from: Date, before: Date): Promise<Array<Omit<NoiseFollowRow, 'venueOpenAt30m'> & { underlyingExchange: string | null }>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; symbol: string; exit_at: Date; after30: unknown; ux: string | null }>>`
      SELECT id, symbol, exit_at, underlying_after_30m AS after30, underlying_exchange AS ux FROM "exit_noise_reads"
      WHERE underlying_after_30m IS NULL AND exit_at >= ${from} AND exit_at <= ${before}`;
    return rows.map((r) => ({ id: r.id, symbol: r.symbol, exitAt: r.exit_at, after30m: num(r.after30), underlyingExchange: r.ux }));
  }

  /** started_at of the first DONE self-review run for a session, or null. */
  async firstDoneReview(session: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT min(started_at) AS at FROM "self_review_runs" WHERE session_date = ${session} AND status = 'DONE'`;
    return rows[0]?.at ?? null;
  }

  // ── sanity_violations (the only table written) ──

  /** Idempotent on (check, subject_id): a repeat only bumps last_seen_at / detail. Returns the stored row. */
  async upsertViolation(v: { check: string; subjectId: string; severity: Severity; detail: Record<string, unknown>; at: Date }): Promise<{ id: string; severity: string; alertedAt: Date | null; inserted: boolean }> {
    const detail = JSON.stringify(v.detail ?? {});
    const rows = await this.prisma.$queryRaw<Array<{ id: string; severity: string; alerted_at: Date | null; inserted: boolean }>>`
      INSERT INTO "sanity_violations" ("id", "check", "subject_id", "severity", "detail", "first_seen_at", "last_seen_at")
      VALUES (${randomUUID()}, ${v.check}, ${v.subjectId}, ${v.severity}, ${detail}::jsonb, ${v.at}, ${v.at})
      ON CONFLICT ("check", "subject_id") DO UPDATE SET "last_seen_at" = EXCLUDED."last_seen_at", "detail" = EXCLUDED."detail"
      RETURNING "id", "severity", "alerted_at", (xmax = 0) AS inserted`;
    const r = rows[0];
    return { id: r.id, severity: r.severity, alertedAt: r.alerted_at, inserted: r.inserted };
  }

  /** Claims the alert of a violation (one sender wins across processes). */
  async claimAlert(id: string, at: Date): Promise<boolean> {
    const n = await this.prisma.$executeRaw`UPDATE "sanity_violations" SET "alerted_at" = ${at} WHERE id = ${id} AND "alerted_at" IS NULL`;
    return n === 1;
  }

  /** Releases a claim whose send failed, so the next run retries it. */
  async releaseAlert(id: string): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "sanity_violations" SET "alerted_at" = NULL WHERE id = ${id}`;
  }

  async listViolations(q: { since: Date; check?: string; severity?: string; limit: number }): Promise<ViolationRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; check: string; subject_id: string; severity: string; detail: unknown; first_seen_at: Date; last_seen_at: Date; alerted_at: Date | null }>>`
      SELECT id, "check", subject_id, severity, detail, first_seen_at, last_seen_at, alerted_at FROM "sanity_violations"
      WHERE last_seen_at >= ${q.since}
        AND (${q.check ?? null}::text IS NULL OR "check" = ${q.check ?? null})
        AND (${q.severity ?? null}::text IS NULL OR severity = ${q.severity ?? null})
      ORDER BY first_seen_at DESC LIMIT ${q.limit}`;
    return rows.map((r) => ({
      id: r.id, check: r.check, subjectId: r.subject_id, severity: r.severity, detail: r.detail,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, alertedAt: r.alerted_at,
    }));
  }
}
