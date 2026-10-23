// apps/api/src/modules/mbm/repositories/mbm-bars.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Candle } from '../../market-data/services/user-historical.util';

/** mbm_bars_1m access: the newest stored broker bar per series, batched broker upserts, tick-bar inserts. */
@Injectable()
export class MbmBarsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest BROKER bar: tick-built bars are ignored, so the next historical fetch re-covers (and overwrites) them. */
  async lastTs(series: string): Promise<Date | null> {
    const r = await this.prisma.mbmBar1m.aggregate({ where: { series, source: null }, _max: { ts: true } });
    return r._max.ts ?? null;
  }

  /**
   * Tick-built bars, only where no bar exists yet (ON CONFLICT DO NOTHING): the broker's historical bar
   * always wins, and a later historical upsert overwrites a tick bar (and clears `source`).
   */
  async insertTickBars(series: string, bars: readonly Candle[]): Promise<number> {
    if (bars.length === 0) return 0;
    const ts = bars.map((b) => b.timestamp.toISOString());
    const col = (k: 'open' | 'high' | 'low' | 'close') => bars.map((b) => b[k]);
    const vol = bars.map((b) => (Number.isFinite(b.volume) ? b.volume : 0));
    return this.prisma.$executeRaw`
      INSERT INTO "mbm_bars_1m" ("series", "ts", "open", "high", "low", "close", "volume", "source")
      SELECT ${series}, t.ts, t.o, t.h, t.l, t.c, t.v, 'tick'
        FROM unnest(${ts}::timestamptz[], ${col('open')}::float8[], ${col('high')}::float8[],
                    ${col('low')}::float8[], ${col('close')}::float8[], ${vol}::float8[])
             AS t(ts, o, h, l, c, v)
      ON CONFLICT ("series", "ts") DO NOTHING`;
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
            "close" = EXCLUDED."close", "volume" = EXCLUDED."volume", "source" = NULL`;
  }
}
