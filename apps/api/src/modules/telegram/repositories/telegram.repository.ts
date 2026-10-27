import { aiScorecard, type AiCheck, type AiScorecard } from '../../signal-trader/domain/ai-check';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface CreateSignalInput {
  messageId: string; channelId: string; symbol: string; token: string | null;
  exchange: string | null; instrument: string; side: string; optionType: string | null;
  strike: number | null; expiry: Date | null; signalType: string; entryMode: string;
  entryLow: number | null; entryHigh: number | null; slMode: string; stopLoss: number | null;
  targets: number[]; horizon: string; parseConfidence: number;
  status: 'PENDING' | 'ACTIVE' | 'UNTRACKABLE'; entryPrice: number | null;
  trackExpiresAt: Date | null;
}

@Injectable()
export class TelegramRepository {
  private readonly logger = new Logger(TelegramRepository.name);
  constructor(private readonly prisma: PrismaService) {}

  async upsertChannel(input: { tgChannelId: string; username?: string | null; title: string }) {
    return this.prisma.telegramChannel.upsert({
      where: { tgChannelId: input.tgChannelId },
      create: { tgChannelId: input.tgChannelId, username: input.username ?? null, title: input.title },
      update: { title: input.title, username: input.username ?? undefined },
      select: { id: true },
    });
  }

  async insertMessage(input: {
    channelId: string; tgMessageId: number; rawText: string; postedAt: Date;
    parseStatus: string; rawPayload: Prisma.InputJsonValue;
  }): Promise<{ id: string } | null> {
    try {
      return await this.prisma.telegramMessage.create({
        data: { ...input }, select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // duplicate — idempotent
      throw e;
    }
  }

  async insertSignal(input: CreateSignalInput): Promise<{ id: string }> {
    return this.prisma.telegramSignal.create({ data: { ...input }, select: { id: true } });
  }

  async advanceLastSeen(channelId: string, tgMessageId: number): Promise<void> {
    await this.prisma.telegramChannel.updateMany({
      where: { id: channelId, lastSeenMsgId: { lt: tgMessageId } },
      data: { lastSeenMsgId: tgMessageId },
    });
  }

  async lastSeenByChannel(): Promise<Record<string, number>> {
    const rows = await this.prisma.telegramChannel.findMany({
      select: { tgChannelId: true, lastSeenMsgId: true },
    });
    return Object.fromEntries(rows.map((r) => [r.tgChannelId, r.lastSeenMsgId]));
  }

  async findActiveSignals() {
    return this.prisma.telegramSignal.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] } },
    });
  }

  async findSignal(id: string) {
    return this.prisma.telegramSignal.findUnique({ where: { id } });
  }

  async transition(signalId: string, patch: Prisma.TelegramSignalUpdateInput): Promise<void> {
    await this.prisma.telegramSignal.update({ where: { id: signalId }, data: patch });
  }

  async addEvent(input: { signalId: string; type: string; price?: number; note?: string }): Promise<void> {
    await this.prisma.telegramSignalEvent.create({
      data: { signalId: input.signalId, type: input.type, price: input.price ?? null, note: input.note ?? null },
    });
  }

  async statsByChannel() {
    return this.prisma.telegramSignal.groupBy({
      by: ['channelId', 'status'], _count: { _all: true }, _avg: { resultPct: true },
    });
  }

  async listChannels() {
    return this.prisma.telegramChannel.findMany({ orderBy: { addedAt: 'desc' } });
  }

  async listSignals(params: { channelId?: string; status?: string; limit: number }) {
    return this.prisma.telegramSignal.findMany({
      where: {
        channelId: params.channelId,
        status: params.status as Prisma.EnumTelegramSignalStatusFilter['equals'],
      },
      orderBy: { createdAt: 'desc' }, take: params.limit,
      include: { message: { select: { rawText: true, postedAt: true } } },
    });
  }

  /**
   * Every stored message, newest first, with what the signal-intake classifier made of it
   * (signal_message_classes) and — for a call — its trade_signals row and latest decision. This is
   * the owner's "did my post arrive and what happened to it" view; the legacy signals above are
   * the pre-intake pipeline (nothing new since 2026-07).
   */
  async feed(params: { limit: number; channelId?: string; statuses?: string[] }): Promise<FeedItem[]> {
    const limit = Math.max(1, Math.min(Math.round(params.limit) || 100, FEED_MAX));
    const byChannel = params.channelId ? Prisma.sql`AND m."channelId" = ${params.channelId}` : Prisma.empty;
    const byStatus = params.statuses?.length ? Prisma.sql`AND c.status IN (${Prisma.join(params.statuses)})` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<FeedRow[]>`
      SELECT m.id, m."channelId" AS channel_id, ch.title AS channel, m."postedAt" AS posted_at, m."receivedAt" AS received_at,
             m."rawText" AS raw_text, m."hasMedia" AS has_media, c.status, c.reason, c.parser,
             s.tradingsymbol, s.side, s.entry_type, s.entry_low, s.entry_high, s.sl, s.targets,
             d.decision, d.skip_reason, d.mode, d.judge_reasons, d.judge_confidence, d.ai_check, w.watches
      FROM telegram_messages m
      JOIN telegram_channels ch ON ch.id = m."channelId"
      LEFT JOIN signal_message_classes c ON c.message_id = m.id
      LEFT JOIN trade_signals s ON s.id = c.signal_id
      LEFT JOIN LATERAL (
        SELECT decision, skip_reason, mode,
               -- The AI judge's own reasons (a SKIP and a TAKE alike): the owner reads why to fix the judge.
               CASE WHEN jsonb_typeof(judge->'reasons') = 'array' THEN judge->'reasons' END AS judge_reasons,
               (judge->>'effectiveConfidence') AS judge_confidence, ai_check
        FROM signal_decisions WHERE signal_id = s.id ORDER BY evaluation DESC LIMIT 1
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'underlying', sw.underlying, 'side', sw.side, 'level', sw.level, 'status', sw.status, 'lastLtp', sw.last_ltp,
                 'decision', wd.decision, 'skipReason', wd.skip_reason) ORDER BY sw.item_index) AS watches
        FROM signal_watches sw
        LEFT JOIN LATERAL (
          SELECT decision, skip_reason FROM signal_decisions WHERE signal_id = sw.signal_id ORDER BY evaluation DESC LIMIT 1
        ) wd ON true
        WHERE sw.message_id = m.id
      ) w ON true
      WHERE true ${byChannel} ${byStatus}
      ORDER BY m."postedAt" DESC
      LIMIT ${limit}`;
    return rows.map(toFeedItem);
  }

  /** Learning mode: how often the AI judge's call matched the paper result, over the last `days`. */
  async aiScorecard(days: number): Promise<AiScorecard & { days: number }> {
    const since = new Date(Date.now() - Math.max(1, Math.min(days, 90)) * 86_400_000);
    const rows = await this.prisma.signalDecision.findMany({ where: { createdAt: { gte: since }, aiCheck: { not: Prisma.DbNull } }, select: { aiCheck: true }, take: 2000 });
    return { ...aiScorecard(rows.map((x) => asAiCheck(x.aiCheck))), days };
  }
}

const FEED_MAX = 300;

function asAiCheck(v: unknown): AiCheck | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d = o.aiDecision === 'TAKE' || o.aiDecision === 'SKIP' || o.aiDecision === 'NONE' ? o.aiDecision : null;
  if (!d) return null;
  return {
    aiDecision: d,
    movePct: Number(o.movePct) || 0,
    pnl: Number(o.pnl) || 0,
    exitTag: String(o.exitTag ?? ''),
    correct: o.correct === true ? true : o.correct === false ? false : null,
    at: String(o.at ?? ''),
  };
}

/** One raw row of {@link TelegramRepository.feed} (snake_case as selected). */
export interface FeedRow {
  id: string;
  channel_id: string;
  channel: string;
  posted_at: Date;
  received_at: Date;
  raw_text: string | null;
  has_media: boolean | null;
  status: string | null;
  reason: string | null;
  parser: string | null;
  tradingsymbol: string | null;
  side: string | null;
  entry_type: string | null;
  entry_low: number | null;
  entry_high: number | null;
  sl: number | null;
  targets: unknown;
  decision: string | null;
  skip_reason: string | null;
  mode: string | null;
  /** json_agg of signal_watches (null when the post has none). */
  watches?: unknown;
  judge_reasons?: unknown;
  ai_check?: unknown;
  judge_confidence?: string | number | null;
}

export interface FeedItem {
  id: string;
  channelId: string;
  channel: string;
  postedAt: string;
  receivedAt: string;
  /** Seconds between the channel posting it and the reader storing it. */
  lagSec: number;
  text: string;
  hasMedia: boolean;
  /** signal_message_classes.status (SIGNAL / INFO / NOISE / …); null = not classified yet. */
  status: string | null;
  reason: string | null;
  parser: string | null;
  call: {
    tradingsymbol: string | null;
    side: string | null;
    entryType: string | null;
    entryLow: number | null;
    entryHigh: number | null;
    sl: number | null;
    targets: number[];
    decision: string | null;
    skipReason: string | null;
    mode: string | null;
    /** The AI judge's reasons (most important first) and its confidence; [] / null when no judge ran. */
    judgeReasons: string[];
    judgeConfidence: number | null;
    /** Learning mode: the closed paper trade held against the judge's call (null until it closes). */
    aiCheck: AiCheck | null;
  } | null;
  /** Breakout levels from this post being watched (signal_watches), with the trade decision once one fired. */
  watches: FeedWatch[];
}

export interface FeedWatch {
  underlying: string;
  side: string;
  level: number;
  status: string;
  lastLtp: number | null;
  decision: string | null;
  skipReason: string | null;
}

function feedWatches(v: unknown): FeedWatch[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object' && typeof (w as { underlying?: unknown }).underlying === 'string')
    .map((w) => ({
      underlying: String(w.underlying),
      side: String(w.side ?? ''),
      level: Number(w.level),
      status: String(w.status ?? ''),
      lastLtp: num(w.lastLtp),
      decision: typeof w.decision === 'string' ? w.decision : null,
      skipReason: typeof w.skipReason === 'string' ? w.skipReason : null,
    }));
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function toFeedItem(r: FeedRow): FeedItem {
  const posted = new Date(r.posted_at);
  const received = new Date(r.received_at);
  return {
    id: r.id,
    channelId: r.channel_id,
    channel: r.channel,
    postedAt: posted.toISOString(),
    receivedAt: received.toISOString(),
    lagSec: Math.max(0, Math.round((received.getTime() - posted.getTime()) / 1000)),
    text: r.raw_text ?? '',
    hasMedia: !!r.has_media,
    status: r.status ?? null,
    reason: r.reason ?? null,
    parser: r.parser ?? null,
    call: r.tradingsymbol
      ? {
          tradingsymbol: r.tradingsymbol,
          side: r.side,
          entryType: r.entry_type,
          entryLow: num(r.entry_low),
          entryHigh: num(r.entry_high),
          sl: num(r.sl),
          targets: Array.isArray(r.targets) ? r.targets.map(num).filter((x): x is number => x !== null) : [],
          decision: r.decision,
          skipReason: r.skip_reason,
          mode: r.mode,
          judgeReasons: Array.isArray(r.judge_reasons) ? r.judge_reasons.filter((x): x is string => typeof x === 'string').slice(0, 6) : [],
          judgeConfidence: num(r.judge_confidence),
          aiCheck: asAiCheck(r.ai_check),
        }
      : null,
    watches: feedWatches(r.watches),
  };
}
