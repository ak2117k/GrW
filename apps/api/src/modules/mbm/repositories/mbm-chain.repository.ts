// apps/api/src/modules/mbm/repositories/mbm-chain.repository.ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PrismaChainRepo } from '../../market-hub/chain/chain-repository';
import type { CaptureContract, ChainSnapshotRow, ChainStrikeRow } from '../domain/chain-snapshot';

/**
 * DB side of the MBM chain capture: option contracts + expiries from the instrument master (the market
 * hub's own reads, so both agree on names and dates), the newest NIFTY 1m close the bar refresher stored,
 * and mbm_chain_snapshots writes/reads. No broker calls here.
 */
@Injectable()
export class MbmChainRepository {
  private readonly master: PrismaChainRepo;

  constructor(private readonly prisma: PrismaService) {
    this.master = new PrismaChainRepo(prisma);
  }

  /** Option expiries (YYYY-MM-DD, ascending) of `name` on or after `todayIst`. */
  expiries(name: string, todayIst: string): Promise<string[]> {
    return this.master.expiries(name, todayIst);
  }

  async contracts(name: string, expiry: string): Promise<CaptureContract[]> {
    const rows = await this.master.contracts(name, expiry);
    return rows
      .filter((c) => c.ref.exchange === 'NFO')
      .map((c) => ({ token: c.ref.token, strike: c.strike, optionType: c.optionType }));
  }

  /** The newest stored 1m close of `series` at/after `since` (the refresher's mbm_bars_1m), else null. */
  async latestClose(series: string, since: Date): Promise<number | null> {
    const row = await this.prisma.mbmBar1m.findFirst({
      where: { series, ts: { gte: since } },
      orderBy: { ts: 'desc' },
      select: { close: true },
    });
    return row && Number.isFinite(row.close) && row.close > 0 ? row.close : null;
  }

  /** Inserts the rows; a row already stored for (instrument, expiry, captured_at) is skipped. */
  async insert(rows: readonly ChainSnapshotRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await this.prisma.mbmChainSnapshot.createMany({
      data: rows.map((r) => ({
        instrument: r.instrument,
        capturedAt: r.capturedAt,
        expiry: new Date(`${r.expiry}T00:00:00Z`),
        spot: r.spot,
        pcr: r.pcr,
        maxPain: r.maxPain,
        callWall: r.callWall,
        putWall: r.putWall,
        strikes: r.strikes as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Strikes of the newest snapshot of (instrument, expiry) captured before `before`; null when none. */
  async strikesBefore(instrument: string, expiry: string, before: Date): Promise<ChainStrikeRow[] | null> {
    const row = await this.prisma.mbmChainSnapshot.findFirst({
      where: { instrument, expiry: new Date(`${expiry}T00:00:00Z`), capturedAt: { lt: before } },
      orderBy: { capturedAt: 'desc' },
      select: { strikes: true },
    });
    return row && Array.isArray(row.strikes) ? (row.strikes as unknown as ChainStrikeRow[]) : null;
  }
}
