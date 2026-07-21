import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramRepository } from '../repositories/telegram.repository';

export interface ChannelScorecard {
  channelId: string; title: string; total: number; wins: number; losses: number;
  expired: number; untrackable: number; winRate: number | null; avgResultPct: number | null;
}

const DEFAULT_MIN_SAMPLE = 5;

@Injectable()
export class TelegramStatsService {
  constructor(
    private readonly repo: TelegramRepository,
    private readonly config: ConfigService,
  ) {}

  async channelScorecards(): Promise<ChannelScorecard[]> {
    const minSample = this.config.get<number>('telegram.minSample') ?? DEFAULT_MIN_SAMPLE;
    const channels = await this.repo.listChannels();
    const grouped = await this.repo.statsByChannel();
    const byChannel = new Map<string, any[]>();
    for (const g of grouped) {
      const arr = byChannel.get(g.channelId) ?? [];
      arr.push(g);
      byChannel.set(g.channelId, arr);
    }
    return channels.map((c) => {
      const rows = byChannel.get(c.id) ?? [];
      const count = (st: string) => rows.find((r) => r.status === st)?._count?._all ?? 0;
      const wins = count('TARGET_HIT');
      const losses = count('SL_HIT');
      const resolved = wins + losses;
      // Count-weighted average of the per-status resultPct means, ignoring nulls
      // (EXPIRED/UNTRACKABLE carry no resultPct).
      const avgs = rows.filter((r) => r._avg?.resultPct != null);
      const avgResultPct = avgs.length
        ? avgs.reduce((a, r) => a + r._avg.resultPct * r._count._all, 0) /
          avgs.reduce((a, r) => a + r._count._all, 0)
        : null;
      return {
        channelId: c.id,
        title: c.title,
        total: rows.reduce((a, r) => a + r._count._all, 0),
        wins,
        losses,
        expired: count('EXPIRED'),
        untrackable: count('UNTRACKABLE'),
        winRate: resolved >= minSample ? wins / resolved : null,
        avgResultPct,
      };
    });
  }
}
