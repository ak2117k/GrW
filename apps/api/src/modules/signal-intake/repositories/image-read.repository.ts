import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ImageSetupKind } from '../domain/image-setup';

export interface ImageReadRow {
  messageId: string;
  channelId: string;
  postedAt: Date;
  kind: ImageSetupKind;
  extraction: Record<string, unknown>;
  valid: boolean;
  reason: string | null;
  model: string | null;
  linkedSignalId?: string | null;
}

/** The slice of the store the image-setup service needs (an in-memory fake in tests). */
export interface ImageReadStore {
  exists(messageId: string): Promise<boolean>;
  save(row: ImageReadRow): Promise<void>;
  /** Rows since `since` that called the model (the daily cap). */
  readsSince(since: Date): Promise<number>;
  link(messageId: string, signalId: string, reason: string): Promise<void>;
  /** The channel's title for the prompt (optional). */
  channelTitle?(channelId: string): Promise<string | null>;
}

/** telegram_image_reads (migration 20261102170000). One row per message: a re-read replaces it. */
@Injectable()
export class ImageReadRepository implements ImageReadStore {
  constructor(private readonly prisma: PrismaService) {}

  async exists(messageId: string): Promise<boolean> {
    return (await this.prisma.telegramImageRead.count({ where: { messageId } })) > 0;
  }

  async save(row: ImageReadRow): Promise<void> {
    const data = {
      channelId: row.channelId,
      postedAt: row.postedAt,
      kind: row.kind,
      extraction: row.extraction as Prisma.InputJsonValue,
      valid: row.valid,
      reason: row.reason?.slice(0, 1000) ?? null,
      model: row.model,
      linkedSignalId: row.linkedSignalId ?? null,
    };
    await this.prisma.telegramImageRead.upsert({ where: { messageId: row.messageId }, create: { messageId: row.messageId, ...data }, update: data });
  }

  readsSince(since: Date): Promise<number> {
    return this.prisma.telegramImageRead.count({ where: { createdAt: { gte: since }, model: { not: null } } });
  }

  async link(messageId: string, signalId: string, reason: string): Promise<void> {
    await this.prisma.telegramImageRead.update({ where: { messageId }, data: { linkedSignalId: signalId, reason: reason.slice(0, 1000) } });
  }

  async channelTitle(channelId: string): Promise<string | null> {
    return (await this.prisma.telegramChannel.findUnique({ where: { id: channelId }, select: { title: true } }))?.title ?? null;
  }
}
