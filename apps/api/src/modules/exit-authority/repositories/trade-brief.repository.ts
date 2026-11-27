import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { TradeBriefsPort } from '../exit-authority.tokens';

/** One brief per tracker (upsert): the supreme writes it at open, its runs and confirms; the agent reads it every look. */
@Injectable()
export class TradeBriefRepository implements TradeBriefsPort {
  constructor(private readonly prisma: PrismaService) {}

  async briefFor(trackerId: string): Promise<string | null> {
    const r = await this.prisma.tradeBrief.findUnique({ where: { trackerId }, select: { text: true } });
    return r?.text ?? null;
  }

  async write(trackerId: string, userId: string, text: string, by: 'OPEN' | 'MANAGER' | 'CONFIRM'): Promise<void> {
    await this.prisma.tradeBrief.upsert({
      where: { trackerId },
      create: { trackerId, userId, text, by },
      update: { userId, text, by },
    });
  }
}
