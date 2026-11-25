import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { RuleParse } from '../domain/parse-compare';
import type { ReadingRow } from '../domain/notes-for-judge';
import type { Claim, ReaderCall, ReadKind, ReadScope } from '../domain/reading.types';
import type { ChannelPost, ReaderPacketSources } from '../services/reader-packet.sources';

export type ReadingStatus = 'READ' | 'FAILED' | 'STALE' | 'CACHED';

/** One message_readings row as the reader writes it (STALE / FAILED rows carry `claims: []`). */
export interface ReadingWrite {
  messageId: string;
  channelId: string;
  postedAt: Date;
  readAt: Date;
  status: ReadingStatus;
  textHash: string;
  claims: Claim[];
  kind?: ReadKind | null;
  scope?: ReadScope | null;
  call?: ReaderCall | null;
  parseAgrees?: boolean | null;
  missedByRules?: boolean;
  /** The rule class the CALL/UPDATE comparison saw; PENDING = the rules had not decided yet; null = not compared. */
  ruleStatus?: string | null;
  summary?: string | null;
  model?: string | null;
  packet?: unknown;
  queuedMs?: number | null;
  packetMs?: number | null;
  aiMs?: number | null;
  error?: string | null;
}

/** A recent READ row whose content a forwarded duplicate copies. */
export interface CachedReading {
  messageId: string;
  kind: ReadKind;
  scope: ReadScope;
  claims: Claim[];
  call: ReaderCall | null;
  summary: string | null;
  model: string | null;
}

/** The rule classifier's view of a post: its class and, when it made a call, the call's levels. */
export interface RuleClass {
  status: string;
  signal: RuleParse | null;
}

export interface ReaderCounts {
  posts: number;
  byStatus: Record<string, number>;
  p50Ms: number | null;
  p95Ms: number | null;
  lastReadAt: Date | null;
}

/** One reading as the owner's "Market notes" list shows it (every status, failures included). */
export interface SessionNote {
  messageId: string;
  channelId: string;
  channelTitle: string;
  postedAt: Date;
  readAt: Date | null;
  status: string;
  kind: string | null;
  scope: string | null;
  claims: Claim[];
  summary: string | null;
  /** queued + packet + AI ms; null when none was measured. */
  latencyMs: number | null;
  error: string | null;
}

export interface UnscoredReading {
  messageId: string;
  channelId: string;
  postedAt: Date;
  sessionDate: string;
  kind: string | null;
  scope: ReadScope;
  claims: Claim[];
  /** The 15:25 IST advance/decline the close-breadth job stored on the row (session = the day it was taken). */
  closeBreadth: { session: string; adAtClose: number } | null;
}

/** What the 15:25 IST job parks in `outcomes` until the night scoring replaces it with the claim scores. */
interface PendingOutcome {
  pending: true;
  adSession: string;
  adAtClose: number;
  adAt: string;
}

const IST_OFFSET_MS = 330 * 60_000;
const istYmd = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const RECENT_POSTS = 20;
const NOTE_ROWS = 50;
const UNSCORED_ROWS = 500;
/** A session's list for the UI (a busy day is a few hundred posts). */
const SESSION_NOTE_ROWS = 1_000;

/** Nearest-rank percentile of an ascending list; null when empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const settled = (c: Claim) => c.verdict === 'CONFIRMED' || c.verdict === 'CONTRADICTED';

/** message_readings: one row per Telegram post (upserted on an edit), plus the packet's two reads. */
@Injectable()
export class MessageReaderRepository implements ReaderPacketSources {
  constructor(private readonly prisma: PrismaService) {}

  async upsertReading(r: ReadingWrite): Promise<void> {
    const data = {
      channelId: r.channelId,
      postedAt: r.postedAt,
      sessionDate: istYmd(r.postedAt),
      readAt: r.readAt,
      status: r.status,
      kind: r.kind ?? null,
      scope: r.scope ?? null,
      claims: r.claims as unknown as Prisma.InputJsonValue,
      call: json(r.call),
      parseAgrees: r.parseAgrees ?? null,
      missedByRules: r.missedByRules ?? false,
      ruleStatus: r.ruleStatus ?? null,
      summary: r.summary ?? null,
      model: r.model ?? null,
      packet: json(r.packet),
      queuedMs: r.queuedMs ?? null,
      packetMs: r.packetMs ?? null,
      aiMs: r.aiMs ?? null,
      textHash: r.textHash,
      error: r.error ?? null,
    };
    // A re-read (edit) replaces the row; any earlier night score no longer applies to the new text.
    await this.prisma.messageReading.upsert({
      where: { messageId: r.messageId },
      create: { messageId: r.messageId, ...data },
      update: { ...data, outcomes: Prisma.DbNull, outcomeFilledAt: null },
    });
  }

  /**
   * A later rule re-check: updates only the comparison fields, and only while the row still holds the
   * reading of the same text (an edit re-read in between wins).
   */
  async updateRuleComparison(
    messageId: string,
    textHash: string,
    c: { parseAgrees: boolean | null; missedByRules: boolean; ruleStatus: string | null },
  ): Promise<void> {
    await this.prisma.messageReading.updateMany({ where: { messageId, textHash }, data: c });
  }

  async readingOf(messageId: string): Promise<{ status: string; textHash: string } | null> {
    return this.prisma.messageReading.findUnique({ where: { messageId }, select: { status: true, textHash: true } });
  }

  /** The newest READ row with this text read at or after `since` (another post than `excludeMessageId`). */
  async cachedByHash(textHash: string, since: Date, excludeMessageId?: string): Promise<CachedReading | null> {
    const hit = await this.prisma.messageReading.findFirst({
      where: { textHash, status: 'READ', readAt: { gte: since }, ...(excludeMessageId ? { messageId: { not: excludeMessageId } } : {}) },
      orderBy: { readAt: 'desc' },
      select: { messageId: true, kind: true, scope: true, claims: true, call: true, summary: true, model: true },
    });
    if (!hit || !hit.kind || !hit.scope) return null;
    return {
      messageId: hit.messageId,
      kind: hit.kind as ReadKind,
      scope: hit.scope as ReadScope,
      claims: (hit.claims ?? []) as unknown as Claim[],
      call: (hit.call ?? null) as unknown as ReaderCall | null,
      summary: hit.summary,
      model: hit.model,
    };
  }

  /** signal_message_classes.status for the post, plus the trade_signals call the rules made from it (if any). */
  async ruleClassOf(messageId: string): Promise<RuleClass | null> {
    const cls = await this.prisma.signalMessageClass.findUnique({ where: { messageId }, select: { status: true, signalId: true } });
    if (!cls) return null;
    const s = cls.signalId
      ? await this.prisma.tradeSignal.findUnique({
          where: { id: cls.signalId },
          select: { underlying: true, side: true, instrumentKind: true, strike: true, entryLow: true, entryHigh: true, sl: true, targets: true },
        })
      : null;
    return {
      status: cls.status,
      signal: s
        ? {
            underlying: s.underlying,
            side: s.side,
            optionType: s.instrumentKind === 'CE' || s.instrumentKind === 'PE' ? s.instrumentKind : null,
            strike: s.strike,
            entryLow: s.entryLow,
            entryHigh: s.entryHigh,
            stopLoss: s.sl,
            targets: Array.isArray(s.targets) ? (s.targets as unknown[]).filter((t): t is number => typeof t === 'number') : [],
          }
        : null,
    };
  }

  async channelTitle(channelId: string): Promise<string | null> {
    const c = await this.prisma.telegramChannel.findUnique({ where: { id: channelId }, select: { title: true } });
    return c?.title ?? null;
  }

  /** The IST session's READ / CACHED readings with their channel titles, newest first. */
  async readingsForSession(sessionDate: string): Promise<ReadingRow[]> {
    const rows = await this.prisma.messageReading.findMany({
      where: { sessionDate, status: { in: ['READ', 'CACHED'] }, scope: { not: null } },
      orderBy: { postedAt: 'desc' },
      select: { messageId: true, channelId: true, postedAt: true, scope: true, claims: true, summary: true },
    });
    const titles = await this.titles(rows.map((r) => r.channelId));
    return rows.map((r) => ({
      messageId: r.messageId,
      channelId: r.channelId,
      channelTitle: titles.get(r.channelId) ?? r.channelId,
      postedAt: r.postedAt,
      scope: r.scope as ReadScope,
      claims: (r.claims ?? []) as unknown as Claim[],
      summary: r.summary,
    }));
  }

  /** Posts received and rows written since `since`; latency = queued + packet + AI of READ rows. */
  async countsSince(since: Date): Promise<ReaderCounts> {
    const [posts, rows, last] = await Promise.all([
      this.prisma.telegramMessage.count({ where: { receivedAt: { gte: since } } }),
      this.prisma.messageReading.findMany({ where: { readAt: { gte: since } }, select: { status: true, queuedMs: true, packetMs: true, aiMs: true } }),
      this.prisma.messageReading.findFirst({ where: { status: 'READ' }, orderBy: { readAt: 'desc' }, select: { readAt: true } }),
    ]);
    const byStatus: Record<string, number> = {};
    const ms: number[] = [];
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.status === 'READ') ms.push((r.queuedMs ?? 0) + (r.packetMs ?? 0) + (r.aiMs ?? 0));
    }
    ms.sort((a, b) => a - b);
    return { posts, byStatus, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), lastReadAt: last?.readAt ?? null };
  }

  /** The newest FAILED reading (the dead-reader alert names its error). */
  async lastFailure(): Promise<{ at: Date | null; error: string | null } | null> {
    const r = await this.prisma.messageReading.findFirst({ where: { status: 'FAILED' }, orderBy: { readAt: 'desc' }, select: { readAt: true, error: true } });
    return r ? { at: r.readAt, error: r.error } : null;
  }

  /** Every reading of the IST session (all statuses) with its channel title, newest post first. */
  async notesForSession(sessionDate: string): Promise<SessionNote[]> {
    const rows = await this.prisma.messageReading.findMany({
      where: { sessionDate },
      orderBy: { postedAt: 'desc' },
      take: SESSION_NOTE_ROWS,
      select: {
        messageId: true,
        channelId: true,
        postedAt: true,
        readAt: true,
        status: true,
        kind: true,
        scope: true,
        claims: true,
        summary: true,
        queuedMs: true,
        packetMs: true,
        aiMs: true,
        error: true,
      },
    });
    const titles = await this.titles(rows.map((r) => r.channelId));
    return rows.map((r) => {
      const parts = [r.queuedMs, r.packetMs, r.aiMs].filter((x): x is number => x !== null);
      return {
        messageId: r.messageId,
        channelId: r.channelId,
        channelTitle: titles.get(r.channelId) ?? r.channelId,
        postedAt: r.postedAt,
        readAt: r.readAt,
        status: r.status,
        kind: r.kind,
        scope: r.scope,
        claims: (r.claims ?? []) as unknown as Claim[],
        summary: r.summary,
        latencyMs: parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null,
        error: r.error,
      };
    });
  }

  /** READ rows posted at or after `since` that the night review has not scored yet, oldest first. */
  async unscored(since: Date): Promise<UnscoredReading[]> {
    const rows = await this.prisma.messageReading.findMany({
      where: { status: 'READ', outcomeFilledAt: null, postedAt: { gte: since }, scope: { not: null } },
      orderBy: { postedAt: 'asc' },
      take: UNSCORED_ROWS,
      select: { messageId: true, channelId: true, postedAt: true, sessionDate: true, kind: true, scope: true, claims: true, outcomes: true },
    });
    return rows.map(({ outcomes, ...r }) => {
      const p = outcomes as Partial<PendingOutcome> | null;
      const closeBreadth = p && p.pending === true && typeof p.adSession === 'string' && typeof p.adAtClose === 'number' ? { session: p.adSession, adAtClose: p.adAtClose } : null;
      return { ...r, scope: r.scope as ReadScope, claims: (r.claims ?? []) as unknown as Claim[], closeBreadth };
    });
  }

  /** Parks the session's 15:25 IST A/D ratio on its not-yet-scored rows (replaced by the scores at night). */
  async storeCloseBreadth(sessionDate: string, adAtClose: number, at: Date): Promise<number> {
    const pending: PendingOutcome = { pending: true, adSession: sessionDate, adAtClose, adAt: at.toISOString() };
    const r = await this.prisma.messageReading.updateMany({
      where: { sessionDate, outcomeFilledAt: null },
      data: { outcomes: pending as unknown as Prisma.InputJsonValue },
    });
    return r.count;
  }

  async fillOutcome(messageId: string, outcomes: unknown[], now: Date): Promise<void> {
    await this.prisma.messageReading.update({ where: { messageId }, data: { outcomes: outcomes as Prisma.InputJsonValue, outcomeFilledAt: now } });
  }

  // ─── ReaderPacketSources (the packet's two database reads) ─────────────────

  async recentChannelPosts(channelId: string, since: Date): Promise<ChannelPost[]> {
    const rows = await this.prisma.telegramMessage.findMany({
      where: { channelId, receivedAt: { gte: since } },
      orderBy: { receivedAt: 'desc' },
      take: RECENT_POSTS,
      select: { receivedAt: true, rawText: true },
    });
    return rows.map((r) => ({ at: r.receivedAt.toISOString(), text: r.rawText }));
  }

  async todayMarketNotes(sessionDate: string): Promise<unknown[]> {
    const rows = await this.prisma.messageReading.findMany({
      where: { sessionDate, status: 'READ', scope: 'MARKET' },
      orderBy: { postedAt: 'desc' },
      take: NOTE_ROWS,
      select: { channelId: true, postedAt: true, summary: true, claims: true },
    });
    const titles = await this.titles(rows.map((r) => r.channelId));
    return rows
      .map((r) => ({
        channel: titles.get(r.channelId) ?? r.channelId,
        postedAt: r.postedAt.toISOString(),
        summary: r.summary,
        claims: ((r.claims ?? []) as unknown as Claim[]).filter(settled).map((c) => ({ text: c.text, bias: c.bias, verdict: c.verdict, evidence: c.evidence })),
      }))
      .filter((r) => r.claims.length > 0);
  }

  private async titles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.telegramChannel.findMany({ where: { id: { in: unique } }, select: { id: true, title: true } });
    return new Map(rows.map((r) => [r.id, r.title]));
  }
}
