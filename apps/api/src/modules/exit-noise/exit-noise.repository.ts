import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OiRow } from '../signal-trader/domain/oi-check';

/** Option / future venues of the master reads (instruments.segment holds these too). */
const DERIVATIVE_EXCHANGES = ['NFO', 'BFO', 'MCX'];

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/** IST calendar date (YYYY-MM-DD) of a master expiry stored at UTC or IST midnight. */
function ymdIst(v: Date | null | undefined): string | null {
  return v ? new Date(v.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) : null;
}

export interface MinuteBar {
  at: Date;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NoiseReadRow {
  source: string;
  refId: string;
  tradeId: string | null;
  trackerId: string | null;
  userId: string | null;
  symbol: string;
  exchange: string | null;
  underlying: string | null;
  underlyingExchange: string | null;
  underlyingToken: string | null;
  side: string;
  want: string;
  exitRule: string;
  exitPrice: number | null;
  exitAt: Date;
  underlyingAtExit: number | null;
  noiseN: number | null;
  verdict: string;
  read: unknown;
}

export interface UnfollowedRow {
  id: string;
  want: string;
  exitAt: Date;
  underlyingAtExit: number | null;
  underlyingExchange: string | null;
  underlyingToken: string | null;
}

/**
 * The exit noise reads' data access. READ-ONLY on every table but exit_noise_reads (the instrument
 * master, oi_snapshots, candles_1m, the sentinel's stored packets,
 * trade_trackers). exit_noise_reads is written with raw SQL so nothing here depends on a regenerated
 * Prisma client.
 */
@Injectable()
export class ExitNoiseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The contract's master row (name = the underlying). */
  async contract(exchange: string, token: string, symbol: string): Promise<{ name: string | null; expiry: string | null; optionType: string | null } | null> {
    const r =
      (await this.prisma.instrument.findFirst({ where: { exchange, token }, select: { name: true, expiry: true, optionType: true } })) ??
      (await this.prisma.instrument.findFirst({ where: { symbol }, select: { name: true, expiry: true, optionType: true } }));
    return r ? { name: r.name ?? null, expiry: ymdIst(r.expiry), optionType: r.optionType ?? null } : null;
  }

  /** A real position's tracker row. */
  async tracker(id: string): Promise<{ userId: string; symbol: string; exchange: string; token: string; qty: number } | null> {
    const t = await this.prisma.tradeTracker.findUnique({ where: { id }, select: { userId: true, symbol: true, exchange: true, token: true, qty: true } });
    return t ? { userId: t.userId, symbol: t.symbol, exchange: t.exchange, token: t.token, qty: Number(t.qty) } : null;
  }

  /** The newest stored packet for the tracker: sentinel_verdicts (real) or paper_sentinel_looks (paper). */
  async latestPacket(trackerId: string, paper: boolean): Promise<{ packet: unknown; at: Date } | null> {
    const where = { trackerId };
    const r = paper
      ? await this.prisma.paperSentinelLook.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { packet: true, createdAt: true } })
      : await this.prisma.sentinelVerdict.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { packet: true, createdAt: true } });
    return r ? { packet: r.packet, at: r.createdAt } : null;
  }

  async optionExpiries(name: string, from: Date): Promise<string[]> {
    const rows = await this.prisma.instrument.findMany({
      where: { name: name.toUpperCase(), exchange: { in: DERIVATIVE_EXCHANGES }, optionType: { in: ['CE', 'PE'] }, isActive: true, expiry: { gte: from } },
      select: { expiry: true },
      distinct: ['expiry'],
      orderBy: { expiry: 'asc' },
      take: 5,
    });
    return [...new Set(rows.map((r) => ymdIst(r.expiry)).filter((x): x is string => !!x))];
  }

  async optionContracts(name: string, expiry: string): Promise<Array<{ instrumentId: string; strike: number; optionType: 'CE' | 'PE' }>> {
    const gte = new Date(`${expiry}T00:00:00+05:30`);
    const rows = await this.prisma.instrument.findMany({
      where: { name: name.toUpperCase(), exchange: { in: DERIVATIVE_EXCHANGES }, optionType: { in: ['CE', 'PE'] }, expiry: { gte, lt: new Date(gte.getTime() + 86_400_000) } },
      select: { id: true, strike: true, optionType: true },
      take: 2000,
    });
    return rows
      .filter((r) => r.strike !== null && (r.optionType === 'CE' || r.optionType === 'PE'))
      .map((r) => ({ instrumentId: r.id, strike: Number(r.strike), optionType: r.optionType as 'CE' | 'PE' }));
  }

  async nearestFuture(name: string, from: Date): Promise<{ instrumentId: string; symbol: string; exchange: string; token: string } | null> {
    const r = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), exchange: { in: DERIVATIVE_EXCHANGES }, optionType: null, symbol: { endsWith: 'FUT' }, isActive: true, expiry: { gte: from } },
      orderBy: { expiry: 'asc' },
      select: { id: true, symbol: true, exchange: true, token: true },
    });
    return r ? { instrumentId: r.id, symbol: r.symbol, exchange: r.exchange, token: r.token } : null;
  }

  async cashRef(name: string): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const n = name.toUpperCase();
    for (const symbol of [`${n}-EQ`, n]) {
      const r = await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' }, select: { exchange: true, token: true, symbol: true } });
      if (r) return r;
    }
    return null;
  }

  async oiRows(ids: string[], from: Date, to: Date): Promise<OiRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.oISnapshot.findMany({
      where: { instrumentId: { in: ids }, timestamp: { gte: from, lte: to } },
      select: { instrumentId: true, oi: true, timestamp: true },
      take: 20_000,
    });
    return rows.map((r) => ({ instrumentId: r.instrumentId, oi: Number(r.oi), at: r.timestamp }));
  }

  /** oi_snapshots.ltp of one instrument (migration 20261029190000); [] when the column is absent or empty. */
  async oiLtps(instrumentId: string, from: Date, to: Date): Promise<Array<{ at: Date; close: number }>> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ timestamp: Date; ltp: number }>>`
        SELECT "timestamp", "ltp" FROM "oi_snapshots"
        WHERE "instrumentId" = ${instrumentId} AND "ltp" IS NOT NULL AND "timestamp" >= ${from} AND "timestamp" <= ${to}
        ORDER BY "timestamp"`;
      return rows.map((r) => ({ at: r.timestamp, close: Number(r.ltp) })).filter((r) => r.close > 0);
    } catch {
      return [];
    }
  }

  /** The hub's tick-built 1m bars (candles_1m) of one instrument in [from, to]. */
  async minuteBars(exchange: string, token: string, from: Date, to: Date): Promise<MinuteBar[]> {
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; high: number; low: number; close: number; volume: bigint | number | null }>>`
      SELECT ts, high, low, close, volume FROM "candles_1m"
      WHERE exchange = ${exchange} AND token = ${token}
        AND ts >= ${from.toISOString()}::timestamptz AND ts <= ${to.toISOString()}::timestamptz
      ORDER BY ts`;
    return rows.map((r) => ({ at: r.ts, high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume ?? 0) }));
  }

  /** At most one row per (source, ref, rule): a second fire of the same exit is ignored. */
  async insert(r: NoiseReadRow): Promise<void> {
    const read = JSON.stringify(r.read ?? {});
    await this.prisma.$executeRaw`
      INSERT INTO "exit_noise_reads" ("id", "source", "ref_id", "trade_id", "tracker_id", "user_id", "symbol", "exchange", "underlying",
        "underlying_exchange", "underlying_token", "side", "want", "exit_rule", "exit_price", "exit_at", "underlying_at_exit", "noise_n", "verdict", "read")
      VALUES (${randomUUID()}, ${r.source}, ${r.refId}, ${r.tradeId}, ${r.trackerId}, ${r.userId}, ${r.symbol}, ${r.exchange}, ${r.underlying},
        ${r.underlyingExchange}, ${r.underlyingToken}, ${r.side}, ${r.want}, ${r.exitRule}, ${r.exitPrice}, ${r.exitAt}, ${r.underlyingAtExit}, ${r.noiseN}, ${r.verdict}, ${read}::jsonb)
      ON CONFLICT ("source", "ref_id", "exit_rule") DO NOTHING`;
  }

  /** Reads whose 30 minutes are over but not followed up yet, exited after `since`. */
  async unfollowed(before: Date, since: Date, limit: number): Promise<UnfollowedRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; want: string; exit_at: Date; underlying_at_exit: number | null; underlying_exchange: string | null; underlying_token: string | null }>>`
      SELECT id, want, exit_at, underlying_at_exit, underlying_exchange, underlying_token FROM "exit_noise_reads"
      WHERE followed_at IS NULL AND exit_at <= ${before} AND exit_at >= ${since}
      ORDER BY exit_at LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, want: r.want, exitAt: r.exit_at, underlyingAtExit: num(r.underlying_at_exit), underlyingExchange: r.underlying_exchange, underlyingToken: r.underlying_token }));
  }

  async setFollow(id: string, f: { after15m: number | null; after30m: number | null; maxFavour30m: number | null; maxAgainst30m: number | null }, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "exit_noise_reads" SET "underlying_after_15m" = ${f.after15m}, "underlying_after_30m" = ${f.after30m},
        "max_favour_30m" = ${f.maxFavour30m}, "max_against_30m" = ${f.maxAgainst30m}, "followed_at" = ${at}
      WHERE id = ${id} AND followed_at IS NULL`;
  }
}

