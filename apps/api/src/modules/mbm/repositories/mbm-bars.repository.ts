// apps/api/src/modules/mbm/repositories/mbm-bars.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Candle } from '../../market-data/services/user-historical.util';

/** mbm_bars_1m access: the newest stored bar per series, and batched upserts. */
@Injectable()
export class MbmBarsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lastTs(series: string): Promise<Date | null> {
    const r = await this.prisma.mbmBar1m.aggregate({ where: { series }, _max: { ts: true } });
    return r._max.ts ?? null;
  }

  /** One INSERT … ON CONFLICT per call (unnest arrays), so a 3-session catch-up is a handful of statements. */
  async upsert(series: string, bars: readonly Candle[]): Promise<number> {
    if (bars.length === 0) return 0;
    const ts = bars.map((b) => b.timestamp.toISOString());
    const col = (k: 'open' | 'high' | 'low' | 'close') => bars.map((b) => b[k]);
    const vol = bars.map((b) => (Number.isFinite(b.volume) ? b.volume : 0));
    return this.prisma.$executeRaw`
      INSERT INTO "mbm_bars_1m" ("series", "ts", "open", "high", "low", "close", "volume")
      SELECT ${series}, t.ts, t.o, t.h, t.l, t.c, t.v
        FROM unnest(${ts}::timestamptz[], ${col('open')}::float8[], ${col('high')}::float8[],
                    ${col('low')}::float8[], ${col('close')}::float8[], ${vol}::float8[])
             AS t(ts, o, h, l, c, v)
      ON CONFLICT ("series", "ts") DO UPDATE
        SET "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low",
            "close" = EXCLUDED."close", "volume" = EXCLUDED."volume"`;
  }
}
