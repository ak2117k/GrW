import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ClusterRow, RecentSignal } from '../domain/cluster';
import type { Direction, MessageStatus } from '../domain/types';

export interface ClassRow {
  messageId: string;
  channelId: string;
  postedAt: Date;
  textHash: string;
  status: MessageStatus;
  reason?: string | null;
  parser?: string | null;
  llmResult?: unknown;
  signalId?: string | null;
  updateKind?: string | null;
  attempts?: number;
}

export interface NewSignal {
  messageId: string;
  channelId: string;
  receivedAt: Date;
  sessionDate: string;
  parser: 'rule' | 'llm';
  underlying: string;
  instrumentKind: string;
  strike: number | null;
  expiry: string | null;
  expirySource: string | null;
  exchange: string | null;
  token: string | null;
  tradingsymbol: string | null;
  side: string;
  direction: Direction;
  entryLow: number;
  entryHigh: number;
  entryType: string;
  sl: number | null;
  targets: number[];
  qty: number | null;
  horizon: string;
  tags: string[];
  confidence: number;
  rawText: string;
  dedupKey: string;
}

export interface StoredSignalRef {
  id: string;
  channelId: string;
  underlying: string;
  strike: number | null;
  receivedAt: Date;
  clusterId: string | null;
}

export interface UnfilledSignal {
  id: string;
  channelId: string;
  receivedAt: Date;
  sessionDate: string;
  underlying: string;
  instrumentKind: string;
  exchange: string | null;
  token: string | null;
  side: string;
  entryType: string;
  entryLow: number;
  entryHigh: number;
  sl: number | null;
  targets: unknown;
  horizon: string;
}

export interface OutcomeWrite {
  status: string;
  session: string | null;
  entryAt: Date | null;
  exitAt: Date | null;
  details: Record<string, unknown>;
}

const json = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/** All of stream S's Postgres access (trade_signals, signal_clusters, signal_message_classes, instruments read). */
@Injectable()
export class SignalIntakeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** NSE cash symbols for the vocabulary (the instruments table, refreshed daily from the Angel master). */
  async cashSymbols(): Promise<string[]> {
    const rows = await this.prisma.instrument.findMany({
      where: { exchange: 'NSE', isActive: true, expiry: null, strike: null },
      select: { symbol: true },
    });
    return rows.map((r) => r.symbol);
  }

  async classOf(messageId: string) {
    return await this.prisma.signalMessageClass.findUnique({ where: { messageId } });
  }

  async saveClass(row: ClassRow): Promise<void> {
    const data = {
      channelId: row.channelId,
      postedAt: row.postedAt,
      textHash: row.textHash,
      status: row.status,
      reason: row.reason ?? null,
      parser: row.parser ?? null,
      llmResult: json(row.llmResult),
      signalId: row.signalId ?? null,
      updateKind: row.updateKind ?? null,
      attempts: row.attempts ?? 0,
    };
    await this.prisma.signalMessageClass.upsert({ where: { messageId: row.messageId }, create: { messageId: row.messageId, ...data }, update: data });
  }

  /** A previous validated LLM reply for exactly this text (the parse cache). */
  async cachedLlm(textHash: string): Promise<unknown | null> {
    const hit = await this.prisma.signalMessageClass.findFirst({
      where: { textHash, NOT: { llmResult: { equals: Prisma.DbNull } } },
      select: { llmResult: true },
      orderBy: { updatedAt: 'desc' },
    });
    return hit?.llmResult ?? null;
  }

  /** LLM_PENDING rows (busy slot) younger than `since`, oldest first. */
  async llmPending(since: Date, take = 20) {
    return await this.prisma.signalMessageClass.findMany({
      where: { status: 'LLM_PENDING', postedAt: { gte: since } },
      orderBy: { postedAt: 'asc' },
      take,
    });
  }

  /** Stream R's stored text of a message (read-only; for retrying a busy-slot LLM parse). */
  async messageText(messageId: string): Promise<string | null> {
    const m = await this.prisma.telegramMessage.findUnique({ where: { id: messageId }, select: { rawText: true } });
    return m?.rawText ?? null;
  }

  /** The same idea from the same channel since `since` (repost / duplicate). */
  async duplicateOf(dedupKey: string, since: Date): Promise<string | null> {
    const hit = await this.prisma.tradeSignal.findFirst({ where: { dedupKey, receivedAt: { gte: since } }, select: { id: true }, orderBy: { receivedAt: 'desc' } });
    return hit?.id ?? null;
  }

  async signalByMessage(messageId: string) {
    return await this.prisma.tradeSignal.findUnique({ where: { messageId } });
  }

  async createSignal(s: NewSignal): Promise<string> {
    const row = await this.prisma.tradeSignal.create({ data: { ...s, targets: s.targets as Prisma.InputJsonValue }, select: { id: true } });
    return row.id;
  }

  async updateSignal(id: string, s: Partial<NewSignal>): Promise<void> {
    const { targets, ...rest } = s;
    await this.prisma.tradeSignal.update({ where: { id }, data: { ...rest, ...(targets ? { targets: targets as Prisma.InputJsonValue } : {}) } });
  }

  async setSignalCluster(id: string, clusterId: string): Promise<void> {
    await this.prisma.tradeSignal.update({ where: { id }, data: { clusterId } });
  }

  async clusters(underlying: string, direction: Direction, since: Date): Promise<ClusterRow[]> {
    const rows = await this.prisma.signalCluster.findMany({
      where: { underlying, direction, windowStart: { gte: since } },
      orderBy: { windowStart: 'desc' },
      take: 5,
    });
    return rows.map((r) => ({ ...r, direction: r.direction as Direction }));
  }

  async recentSignals(underlying: string, since: Date): Promise<RecentSignal[]> {
    const rows = await this.prisma.tradeSignal.findMany({
      where: { underlying, receivedAt: { gte: since } },
      select: { id: true, channelId: true, direction: true, receivedAt: true, clusterId: true },
      take: 200,
    });
    return rows.map((r) => ({ ...r, direction: r.direction as Direction }));
  }

  async createCluster(c: Omit<ClusterRow, 'id'>): Promise<string> {
    const row = await this.prisma.signalCluster.create({ data: { ...c, status: 'OPEN' }, select: { id: true } });
    return row.id;
  }

  async updateCluster(c: ClusterRow): Promise<void> {
    await this.prisma.signalCluster.update({
      where: { id: c.id },
      data: { channelIds: c.channelIds, signalIds: c.signalIds, agreeCount: c.agreeCount, conflict: c.conflict },
    });
  }

  async flagConflict(ids: string[]): Promise<void> {
    if (ids.length) await this.prisma.signalCluster.updateMany({ where: { id: { in: ids } }, data: { conflict: true } });
  }

  /** The latest signal per channel among `ids` (re-emit targets when a cluster is corroborated). */
  async signalsByIds(ids: string[]): Promise<StoredSignalRef[]> {
    if (ids.length === 0) return [];
    return this.prisma.tradeSignal.findMany({
      where: { id: { in: ids } },
      select: { id: true, channelId: true, underlying: true, strike: true, receivedAt: true, clusterId: true },
      orderBy: { receivedAt: 'desc' },
    });
  }

  /** The channel's recent signals, newest first (update linking). */
  latestInChannel(channelId: string, since: Date, take = 20): Promise<StoredSignalRef[]> {
    return this.prisma.tradeSignal.findMany({
      where: { channelId, receivedAt: { gte: since } },
      select: { id: true, channelId: true, underlying: true, strike: true, receivedAt: true, clusterId: true },
      orderBy: { receivedAt: 'desc' },
      take,
    });
  }

  // ─── Outcomes ──────────────────────────────────────────────────────────────

  /** Signals posted on sessions [fromSession, toSession] with no outcome yet. */
  unfilled(fromSession: string, toSession: string, take = 300): Promise<UnfilledSignal[]> {
    return this.prisma.tradeSignal.findMany({
      where: { outcomeFilledAt: null, sessionDate: { gte: fromSession, lte: toSession } },
      select: {
        id: true, channelId: true, receivedAt: true, sessionDate: true, underlying: true, instrumentKind: true, exchange: true, token: true,
        side: true, entryType: true, entryLow: true, entryHigh: true, sl: true, targets: true, horizon: true,
      },
      orderBy: { receivedAt: 'asc' },
      take,
    });
  }

  async fillOutcome(id: string, o: OutcomeWrite, now: Date): Promise<void> {
    await this.prisma.tradeSignal.update({
      where: { id },
      data: {
        outcomeStatus: o.status,
        outcomeSession: o.session,
        outcomeEntryAt: o.entryAt,
        outcomeExitAt: o.exitAt,
        outcomeDetails: o.details as Prisma.InputJsonValue,
        outcomeFilledAt: now,
      },
    });
  }
}
