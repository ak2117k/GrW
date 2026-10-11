import { Prisma } from '@prisma/client';
import type { OptionsChainEntry } from '@td/shared/types';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { HubExchange, InstrumentRef } from '../hub.types';
import { INDEX_UNDERLYINGS } from '../underlying';
import type { ChainContract, HubChain, OiRow } from './chain.types';
import { localMidnight, nextYmd, ymdLocal } from './chain-dates';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_LOOKBACK_MS = 10 * DAY_MS;

/**
 * A stored chain carries no Greeks provenance, so derive it: 'broker' when any leg has an IV
 * (it had Greeks from somewhere), else 'none'. Local vs broker cannot be told apart after the fact.
 */
function storedGreeksSource(entries: readonly OptionsChainEntry[]): 'broker' | 'none' {
  const hasIv = entries.some((e) => (e?.ceData?.iv ?? 0) > 0 || (e?.peData?.iv ?? 0) > 0);
  return hasIv ? 'broker' : 'none';
}

export interface ChainRepo {
  /** Active CE/PE contracts of exactly `name` expiring on `expiry` (YYYY-MM-DD), NFO or MCX. */
  contracts(name: string, expiry: string): Promise<ChainContract[]>;
  /** Distinct expiries (YYYY-MM-DD, ascending) of `name`'s options on or after `today` (IST YYYY-MM-DD). */
  expiries(name: string, today: string): Promise<string[]>;
  /** Where the underlying's price lives: index map, MCX nearest future of exactly `name`, or NSE cash. */
  underlyingRef(name: string, exchange: HubExchange, expiry: string): Promise<InstrumentRef | null>;
  /** Master name + expiry of each derivative ref (held positions → chain keys). Unknown refs are skipped. */
  describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>>;
  /** Each instrument's LAST oi strictly before `before` (within 10 days). */
  baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>>;
  writeOi(rows: readonly OiRow[]): Promise<number>;
  writeChainSnapshot(chain: HubChain): Promise<void>;
  /** Latest stored chain for (underlying, expiry), any source, labelled with the caller's venue; null when none. */
  latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null>;
  pruneOi(before: Date): Promise<number>;
}

/** The chain's database reads and writes. Names are matched EXACTLY (CRUDEOIL ≠ CRUDEOILM). */
export class PrismaChainRepo implements ChainRepo {
  constructor(private readonly prisma: PrismaService) {}

  async contracts(name: string, expiry: string): Promise<ChainContract[]> {
    const rows = await this.prisma.instrument.findMany({
      where: {
        name: name.toUpperCase(),
        exchange: { in: ['NFO', 'MCX'] },
        optionType: { in: ['CE', 'PE'] },
        isActive: true,
        expiry: { gte: localMidnight(expiry), lt: localMidnight(nextYmd(expiry)) },
      },
      select: { id: true, token: true, symbol: true, exchange: true, strike: true, optionType: true, lotSize: true },
    });
    return rows
      .filter((r) => r.strike !== null && (r.optionType === 'CE' || r.optionType === 'PE'))
      .map((r) => ({
        instrumentId: r.id,
        ref: { exchange: r.exchange as HubExchange, token: r.token, symbol: r.symbol },
        strike: Number(r.strike),
        optionType: r.optionType as 'CE' | 'PE',
        lotSize: r.lotSize,
      }));
  }

  async expiries(name: string, today: string): Promise<string[]> {
    const rows = await this.prisma.instrument.findMany({
      where: {
        name: name.toUpperCase(),
        exchange: { in: ['NFO', 'MCX'] },
        optionType: { in: ['CE', 'PE'] },
        isActive: true,
        expiry: { gte: localMidnight(today) },
      },
      select: { expiry: true },
      distinct: ['expiry'],
      orderBy: { expiry: 'asc' },
    });
    return [...new Set(rows.filter((r) => r.expiry).map((r) => ymdLocal(r.expiry as Date)))];
  }

  async underlyingRef(name: string, exchange: HubExchange, expiry: string): Promise<InstrumentRef | null> {
    const n = name.toUpperCase();
    const index = INDEX_UNDERLYINGS[n];
    if (index) return { ...index };
    if (exchange === 'MCX') {
      const fut = await this.prisma.instrument.findFirst({
        where: { name: n, exchange: 'MCX', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight(expiry) } },
        orderBy: { expiry: 'asc' },
      });
      return fut ? { exchange: 'MCX', token: fut.token, symbol: fut.symbol } : null;
    }
    for (const symbol of [`${n}-EQ`, n]) {
      const cash = await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' } });
      if (cash) return { exchange: 'NSE', token: cash.token, symbol: cash.symbol };
    }
    return null;
  }

  async describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>> {
    const derivatives = refs.filter((r) => r.exchange === 'NFO' || r.exchange === 'MCX');
    if (derivatives.length === 0) return [];
    const rows = await this.prisma.instrument.findMany({
      where: { OR: derivatives.map((r) => ({ exchange: r.exchange, token: r.token })) },
      select: { name: true, expiry: true },
    });
    const out = new Map<string, { name: string; expiry: string }>();
    for (const r of rows) {
      if (!r.name || !r.expiry) continue;
      const e = { name: r.name.toUpperCase(), expiry: ymdLocal(r.expiry) };
      out.set(`${e.name}:${e.expiry}`, e);
    }
    return [...out.values()];
  }

  async baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>> {
    if (instrumentIds.length === 0) return new Map();
    const since = new Date(before.getTime() - BASELINE_LOOKBACK_MS);
    const rows = await this.prisma.$queryRaw<Array<{ instrumentId: string; oi: bigint }>>`
      SELECT DISTINCT ON ("instrumentId") "instrumentId", "oi"
      FROM "oi_snapshots"
      WHERE "instrumentId" IN (${Prisma.join([...instrumentIds])})
        AND "timestamp" < ${before} AND "timestamp" >= ${since}
      ORDER BY "instrumentId", "timestamp" DESC`;
    return new Map(rows.map((r) => [r.instrumentId, Number(r.oi)]));
  }

  async writeOi(rows: readonly OiRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await this.prisma.oISnapshot.createMany({
      data: rows.map((r) => ({
        instrumentId: r.instrumentId,
        oi: BigInt(Math.round(r.oi)),
        oiChange: r.oiChange === null ? null : BigInt(Math.round(r.oiChange)),
        volume: BigInt(Math.round(r.volume)),
        timestamp: r.at,
      })),
    });
    return res.count;
  }

  async writeChainSnapshot(chain: HubChain): Promise<void> {
    await this.prisma.optionChainSnapshot.create({
      data: {
        underlying: chain.underlying.toUpperCase(),
        // Same encoding as OptionsChainService.persistSnapshot (a @db.Date column).
        expiryDate: new Date(chain.expiry),
        spotPrice: chain.spot ?? 0,
        source: 'HUB',
        strikeCount: chain.entries.length,
        chainJson: chain.entries as unknown as Prisma.InputJsonValue,
        capturedAt: new Date(chain.at),
      },
    });
  }

  /** A snapshot row does not store its venue; the caller (who knows it from the contracts) passes it. */
  async latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null> {
    const u = underlying.toUpperCase();
    const row = await this.prisma.optionChainSnapshot.findFirst({
      where: { underlying: u, expiryDate: new Date(expiry) },
      orderBy: { capturedAt: 'desc' },
    });
    if (!row) return null;
    const spot = Number(row.spotPrice);
    const entries = (Array.isArray(row.chainJson) ? row.chainJson : []) as unknown as OptionsChainEntry[];
    return {
      underlying: u,
      expiry,
      exchange,
      spot: spot > 0 ? spot : null,
      at: row.capturedAt.getTime(),
      greeks: storedGreeksSource(entries),
      entries,
    };
  }

  async pruneOi(before: Date): Promise<number> {
    const res = await this.prisma.oISnapshot.deleteMany({ where: { timestamp: { lt: before } } });
    return res.count;
  }
}
