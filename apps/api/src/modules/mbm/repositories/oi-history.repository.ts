// apps/api/src/modules/mbm/repositories/oi-history.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { localMidnight, ymdLocal } from '../../market-hub/chain/chain-dates';
import { PrismaChainRepo } from '../../market-hub/chain/chain-repository';
import type { OiPoint } from '../../market-data/services/oi-data.util';
import type { OiContract } from '../domain/oi-history';

/** Where one contract's backfill stands (a nifty_oi_backfill_progress row). */
export interface OiProgress {
  cursor: Date | null;
  coveredTo: Date | null;
  emptyStreak: number;
  done: boolean;
  earliestTs: Date | null;
  latestTs: Date | null;
  rows: number;
  calls: number;
}

export interface OiKindSummary {
  kind: string;
  contracts: number;
  done: number;
  earliest: Date | null;
  rows: number;
}

/**
 * DB side of the NIFTY past-OI backfill: the live NIFTY futures / option contracts from the instrument
 * master (the market hub's reads), nifty_oi_history writes and the per-contract progress rows.
 */
@Injectable()
export class OiHistoryRepository {
  private readonly master: PrismaChainRepo;

  constructor(private readonly prisma: PrismaService) {
    this.master = new PrismaChainRepo(prisma);
  }

  /** Every unexpired NFO future of `name` (expiry ascending). */
  async futures(name: string, todayIst: string): Promise<OiContract[]> {
    const rows = await this.prisma.instrument.findMany({
      where: { name: name.toUpperCase(), exchange: 'NFO', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight(todayIst) } },
      orderBy: { expiry: 'asc' },
      select: { token: true, symbol: true, expiry: true },
    });
    return rows
      .filter((r) => r.expiry)
      .map((r) => ({ token: r.token, symbol: r.symbol, kind: 'FUT' as const, expiry: ymdLocal(r.expiry as Date), strike: null }));
  }

  /** Option expiries (YYYY-MM-DD, ascending) of `name` on or after `todayIst`. */
  optionExpiries(name: string, todayIst: string): Promise<string[]> {
    return this.master.expiries(name, todayIst);
  }

  async options(name: string, expiry: string): Promise<OiContract[]> {
    const rows = await this.master.contracts(name, expiry);
    return rows
      .filter((c) => c.ref.exchange === 'NFO')
      .map((c) => ({ token: c.ref.token, symbol: c.ref.symbol ?? c.ref.token, kind: c.optionType, expiry, strike: c.strike }));
  }

  async progress(interval: string, tokens: readonly string[]): Promise<Map<string, OiProgress>> {
    const out = new Map<string, OiProgress>();
    for (let i = 0; i < tokens.length; i += 1000) {
      const rows = await this.prisma.niftyOiBackfillProgress.findMany({ where: { interval, token: { in: tokens.slice(i, i + 1000) } } });
      for (const r of rows) {
        out.set(r.token, {
          cursor: r.cursor,
          coveredTo: r.coveredTo,
          emptyStreak: r.emptyStreak,
          done: r.done,
          earliestTs: r.earliestTs,
          latestTs: r.latestTs,
          rows: r.rows,
          calls: r.calls,
        });
      }
    }
    return out;
  }

  async saveProgress(c: OiContract, interval: string, p: OiProgress): Promise<void> {
    const data = {
      symbol: c.symbol,
      kind: c.kind,
      expiry: new Date(`${c.expiry}T00:00:00Z`),
      strike: c.strike,
      cursor: p.cursor,
      coveredTo: p.coveredTo,
      emptyStreak: p.emptyStreak,
      done: p.done,
      earliestTs: p.earliestTs,
      latestTs: p.latestTs,
      rows: p.rows,
      calls: p.calls,
    };
    await this.prisma.niftyOiBackfillProgress.upsert({
      where: { token_interval: { token: c.token, interval } },
      create: { token: c.token, interval, ...data },
      update: data,
    });
  }

  /** Inserts the points; a bar already stored for (token, interval, ts) is skipped. Returns rows added. */
  async insert(c: OiContract, interval: string, points: readonly OiPoint[]): Promise<number> {
    if (points.length === 0) return 0;
    const expiry = new Date(`${c.expiry}T00:00:00Z`);
    let added = 0;
    for (let i = 0; i < points.length; i += 5000) {
      const res = await this.prisma.niftyOiHistory.createMany({
        data: points.slice(i, i + 5000).map((p) => ({ token: c.token, symbol: c.symbol, kind: c.kind, expiry, strike: c.strike, interval, ts: p.ts, oi: p.oi })),
        skipDuplicates: true,
      });
      added += res.count;
    }
    return added;
  }

  /** Per kind for `interval`: contracts tracked, how many finished walking back, the oldest bar stored, rows. */
  summary(interval: string): Promise<OiKindSummary[]> {
    return this.prisma.$queryRaw<OiKindSummary[]>`
      SELECT kind, COUNT(*)::int AS contracts, COUNT(*) FILTER (WHERE done)::int AS done,
             MIN(earliest_ts) AS earliest, COALESCE(SUM(rows), 0)::int AS rows
      FROM nifty_oi_backfill_progress WHERE interval = ${interval}
      GROUP BY kind ORDER BY kind`;
  }

  /** Over every interval: progress rows, the ones still walking back, and the stalest forward edge of unexpired ones. */
  async pending(todayIst: string): Promise<{ total: number; pending: number; stalest: Date | null }> {
    const where = { expiry: { gte: new Date(`${todayIst}T00:00:00Z`) } };
    const [total, pending, stalest] = await Promise.all([
      this.prisma.niftyOiBackfillProgress.count({ where }),
      this.prisma.niftyOiBackfillProgress.count({ where: { ...where, done: false } }),
      this.prisma.niftyOiBackfillProgress.findFirst({ where, orderBy: { coveredTo: { sort: 'asc', nulls: 'first' } }, select: { coveredTo: true } }),
    ]);
    return { total, pending, stalest: stalest ? stalest.coveredTo : null };
  }
}
