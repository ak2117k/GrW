import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TgDialog } from '../client/telegram-client.port';
import { TelegramListenerService } from './telegram-listener.service';
import { TelegramSessionStore } from './telegram-session.store';

export const MAX_ENABLED_CHANNELS = 10;

export interface PickerDialog extends TgDialog {
  enabled: boolean;
}

export interface EnabledChannelView {
  id: string;
  tgChannelId: string;
  title: string;
  username: string | null;
  memberCount: number | null;
}

/** Channel picker + disconnect. Dialog metadata always comes from Telegram, never from the client. */
@Injectable()
export class TelegramChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listener: TelegramListenerService,
    private readonly store: TelegramSessionStore,
  ) {}

  async listEnabled(userId: string): Promise<EnabledChannelView[]> {
    return this.prisma.telegramChannel.findMany({
      where: { userId, enabled: true },
      select: { id: true, tgChannelId: true, title: true, username: true, memberCount: true },
      orderBy: { title: 'asc' },
    });
  }

  async dialogs(userId: string): Promise<PickerDialog[]> {
    const dialogs = await this.liveDialogs();
    const on = new Set((await this.listEnabled(userId)).map((c) => c.tgChannelId));
    return dialogs
      .map((d) => ({ ...d, enabled: on.has(d.tgChannelId) }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title));
  }

  /** Replace the enabled set with exactly `tgChannelIds` (max 10). */
  async setEnabled(userId: string, tgChannelIds: string[]): Promise<EnabledChannelView[]> {
    const ids = [...new Set(tgChannelIds.map((s) => String(s).trim()).filter(Boolean))];
    if (ids.length > MAX_ENABLED_CHANNELS) {
      throw new BadRequestException(`At most ${MAX_ENABLED_CHANNELS} channels can be enabled.`);
    }
    const byId = new Map((await this.liveDialogs()).map((d) => [d.tgChannelId, d]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw new BadRequestException('Some selected chats are not in your Telegram dialogs.');

    await this.prisma.$transaction(async (tx) => {
      await tx.telegramChannel.updateMany({
        where: { userId, enabled: true, tgChannelId: { notIn: ids } },
        data: { enabled: false },
      });
      for (const id of ids) {
        const d = byId.get(id)!;
        const data = { title: d.title, username: d.username, memberCount: d.memberCount, userId, enabled: true };
        await tx.telegramChannel.upsert({
          where: { tgChannelId: id },
          create: { tgChannelId: id, ...data, joinedAt: new Date() },
          update: data,
        });
      }
    });
    await this.listener.refreshChannels();
    return this.listEnabled(userId);
  }

  /** Revoke on Telegram (best effort), stop listening, delete the sealed session. Channel picks are kept. */
  async disconnect(userId: string, reqMeta: Record<string, unknown> = {}): Promise<void> {
    const c = this.listener.liveClient();
    if (c) await c.logOut().catch(() => undefined);
    await this.listener.stop();
    await this.store.delete(userId, reqMeta);
  }

  private async liveDialogs(): Promise<TgDialog[]> {
    const client = this.listener.liveClient();
    if (!client) throw new ConflictException('Telegram is not connected (or still connecting).');
    return client.listDialogs();
  }
}
