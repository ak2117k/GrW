// apps/api/src/modules/mbm/repositories/mbm-chain.repository.ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { localMidnight } from '../../market-hub/chain/chain-dates';
import { PrismaChainRepo } from '../../market-hub/chain/chain-repository';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { derivativeUnderlying } from '../../trade-sentinel/overnight/pre-open-check';
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
        fut: r.fut ?? null,
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

  /** NFO token of `name`'s nearest unexpired index/stock future (optionType null, symbol …FUT); null when unlisted. */
  async nearestFutureToken(name: string, todayIst: string): Promise<string | null> {
    const fut = await this.prisma.instrument.findFirst({
      where: { name: name.toUpperCase(), exchange: 'NFO', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight(todayIst) } },
      orderBy: { expiry: 'asc' },
      select: { token: true },
    });
    return fut?.token ?? null;
  }

  /** Per instrument: distinct capture ticks, rows and the newest capture in [from, to). */
  async captureCounts(from: Date, to: Date): Promise<Array<{ instrument: string; ticks: number; rows: number; newest: Date }>> {
    return this.prisma.$queryRaw<Array<{ instrument: string; ticks: number; rows: number; newest: Date }>>`
      SELECT instrument, COUNT(DISTINCT captured_at)::int AS ticks, COUNT(*)::int AS rows, MAX(captured_at) AS newest
      FROM mbm_chain_snapshots WHERE captured_at >= ${from} AND captured_at < ${to}
      GROUP BY instrument ORDER BY instrument`;
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

  /** Where `name`'s price lives (index map, else the NSE cash row); null when the master has neither. */
  underlyingRef(name: string, expiry: string): Promise<InstrumentRef | null> {
    return this.master.underlyingRef(name, 'NFO', expiry);
  }

  /**
   * Underlying names of `userId`'s OPEN broker-synced NFO positions (trade_trackers kind POSITION): the
   * instrument master's `name` for the contract token, else parsed from the trading symbol. Distinct.
   */
  async openFnoUnderlyings(userId: string): Promise<string[]> {
    const open = await this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN', kind: 'POSITION', exchange: 'NFO' },
      select: { symbol: true, token: true },
    });
    if (open.length === 0) return [];
    const master = await this.prisma.instrument.findMany({
      where: { exchange: 'NFO', token: { in: open.map((t) => t.token) } },
      select: { token: true, name: true },
    });
    const byToken = new Map<string, string>();
    for (const m of master) if (m.name) byToken.set(m.token, m.name.trim().toUpperCase());
    const out = new Set<string>();
    for (const t of open) {
      const name = byToken.get(t.token) || derivativeUnderlying(t.symbol);
      if (name) out.add(name);
    }
    return [...out];
  }

  /** (capturedAt, expiry) keys of `instrument`'s snapshots at/after `since`, newest capture first (expiry ascending within), ≤ `take`. Light: no strikes. */
  async captureKeys(instrument: string, since: Date, take: number): Promise<Array<{ capturedAt: Date; expiry: string }>> {
    const rows = await this.prisma.mbmChainSnapshot.findMany({
      where: { instrument, capturedAt: { gte: since } },
      orderBy: [{ capturedAt: 'desc' }, { expiry: 'asc' }],
      select: { capturedAt: true, expiry: true },
      take,
    });
    return rows.map((r) => ({ capturedAt: r.capturedAt, expiry: r.expiry.toISOString().slice(0, 10) }));
  }

  /** The full snapshot rows of `instrument` at exactly these keys, in the keys' order (missing ones dropped). */
  async snapshotsAt(instrument: string, keys: ReadonlyArray<{ capturedAt: Date; expiry: string }>): Promise<ChainSnapshotRow[]> {
    if (keys.length === 0) return [];
    const rows = await this.prisma.mbmChainSnapshot.findMany({
      where: { instrument, OR: keys.map((k) => ({ capturedAt: k.capturedAt, expiry: new Date(`${k.expiry}T00:00:00Z`) })) },
    });
    const mapped: ChainSnapshotRow[] = rows.map((r) => ({
      instrument: r.instrument,
      expiry: r.expiry.toISOString().slice(0, 10),
      capturedAt: r.capturedAt,
      spot: r.spot,
      fut: r.fut,
      pcr: r.pcr,
      maxPain: r.maxPain,
      callWall: r.callWall,
      putWall: r.putWall,
      strikes: Array.isArray(r.strikes) ? (r.strikes as unknown as ChainStrikeRow[]) : [],
    }));
    const key = (k: { capturedAt: Date; expiry: string }) => `${k.capturedAt.getTime()}|${k.expiry}`;
    const byKey = new Map(mapped.map((r) => [key(r), r] as const));
    return keys.map((k) => byKey.get(key(k))).filter((r): r is ChainSnapshotRow => !!r);
  }
}
