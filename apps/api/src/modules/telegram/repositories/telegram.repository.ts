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
}
