import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { setTelegramOutboxRecorder, type TelegramOutboxRow } from '../utils/telegram-outbox';

const WARN_EVERY_MS = 10 * 60_000;

/**
 * Points the Telegram outbox (common/utils/telegram-outbox.ts) at the `telegram_outbox` table once
 * Nest boots. A failed insert is logged at most once per 10 min and never reaches the sender.
 */
@Injectable()
export class TelegramOutboxRegistrar implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TelegramOutbox');
  private lastWarn = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    setTelegramOutboxRecorder(
      (row: TelegramOutboxRow) => this.prisma.telegramOutbox.create({ data: row }),
      (err) => {
        const now = Date.now();
        if (now - this.lastWarn < WARN_EVERY_MS) return;
        this.lastWarn = now;
        this.log.warn(`telegram_outbox write failed (send not affected): ${(err as Error)?.message ?? String(err)}`.slice(0, 400));
      },
    );
  }

  onModuleDestroy(): void {
    setTelegramOutboxRecorder(null);
  }
}
