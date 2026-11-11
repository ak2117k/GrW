import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Bar1m, ImpactRow } from './domain/entry-decision';
import type { PreOpenBiasInput } from './domain/news-paths';
import type { StrikeLiquidity } from './domain/engine-contract';
import { ENGINE_ENTRY_STRATEGY, ENGINE_UNDERLYING_TAG, type EntryEngineMode } from './entry-engine.config';

export interface DecisionRow {
  id: string;
  underlying: string;
  at: Date;
  action: string;
  mode: EntryEngineMode;
  inputs: unknown;
  reasons: string[];
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The entry engine's data access. READ-ONLY on everything but entry_engine_decisions (news_impacts /
 * news_clusters, candles_1m, candles, trades). entry_engine_decisions is written with raw SQL so
 * nothing here depends on a regenerated Prisma client (migration 20261030160000_entry_engine_decisions).
 */
@Injectable()
export class EntryEngineRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Per-strike liquidity of one option series from the chain snapshots (oi_snapshots, ~3-min cadence): today's
   * volume (latest snapshot since `dayStart`) and the distinct prices printed since `recentFrom`. Joined by the
   * contract's own name / expiry / type / strike — never a token (tokens are reused across expiries). Empty map ⇒
   * no snapshots for this series (pickLiquidStrike then flags it unchecked).
   */
  async strikeLiquidity(name: string, kind: 'CE' | 'PE', expiryYmd: string, strikes: readonly number[], dayStart: Date, recentFrom: Date): Promise<Map<number, StrikeLiquidity>> {
    if (strikes.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ strike: number; volume: unknown; moves: unknown }>>`
      SELECT i.strike AS strike,
        COALESCE((array_agg(o.volume ORDER BY o."timestamp" DESC))[1], 0) AS volume,
        COUNT(DISTINCT o.ltp) FILTER (WHERE o."timestamp" >= ${recentFrom}) AS moves
      FROM "oi_snapshots" o JOIN "instruments" i ON i.id = o."instrumentId"
      WHERE UPPER(i.name) = ${name.toUpperCase()} AND i."optionType" = ${kind}
        AND (i.expiry::date = ${expiryYmd}::date OR (i.expiry + interval '5 hours 30 minutes')::date = ${expiryYmd}::date)
        AND i.strike = ANY(${[...strikes]}::float8[]) AND o."timestamp" >= ${dayStart}
      GROUP BY i.strike`;
    return new Map(rows.map((r) => [Number(r.strike), { volume: num(r.volume), moves: num(r.moves) }]));
  }

  /** Impacts the model read in (from, to], joined to their cluster. */
  async impacts(from: Date, to: Date): Promise<ImpactRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT i.cluster_id, i.analysed_at, c.first_seen, i.direction, i.magnitude, i.confidence, i.priced_in, i.symbols, i.sectors,
        i.index_name, c.material, c.material_type, c.headline, c.sources, c.instruments
      FROM "news_impacts" i JOIN "news_clusters" c ON c.id = i.cluster_id
      WHERE i.analysed_at > ${from} AND i.analysed_at <= ${to}
      ORDER BY i.analysed_at DESC LIMIT 500`;
    return rows.map((r) => ({
      clusterId: String(r.cluster_id),
      analysedAt: r.analysed_at as Date,
      firstSeen: r.first_seen as Date,
      direction: String(r.direction),
      magnitude: String(r.magnitude),
      confidence: num(r.confidence),
      pricedIn: r.priced_in === true,
      symbols: Array.isArray(r.symbols) ? (r.symbols as string[]) : [],
      sectors: Array.isArray(r.sectors) ? (r.sectors as string[]) : [],
      indexName: typeof r.index_name === 'string' ? r.index_name : null,
      material: r.material === true,
      materialType: typeof r.material_type === 'string' ? r.material_type : null,
      headline: String(r.headline ?? ''),
      sources: Array.isArray(r.sources) ? (r.sources as string[]) : [],
      instruments: Array.isArray(r.instruments) ? (r.instruments as string[]) : [],
    }));
  }

  /**
   * The latest pre-open outlook for (underlying, IST session date) — pre_open_outlooks, written by the
   * pre-open-outlook module (migration 20261102130000_global_price_snapshots). null when none (or the
   * table is not there yet): the PRE_OPEN news path then simply does not apply.
   */
  async preOpenOutlook(underlying: string, sessionDate: string): Promise<PreOpenBiasInput | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT underlying, to_char(session_date, 'YYYY-MM-DD') AS session_date, bias, confidence, at, summary FROM "pre_open_outlooks"
        WHERE underlying = ${underlying.toUpperCase()} AND session_date = ${sessionDate}::date
        ORDER BY at DESC LIMIT 1`;
      const r = rows[0];
      if (!r) return null;
      const bias = String(r.bias);
      return {
        underlying: String(r.underlying),
        sessionDate: String(r.session_date),
        bias: bias === 'BULLISH' || bias === 'BEARISH' ? bias : 'NEUTRAL',
        confidence: num(r.confidence),
        at: (r.at as Date).toISOString(),
        summary: String(r.summary ?? ''),
      };
    } catch {
      return null;
    }
  }

  /** The hub's 1-minute bars (candles_1m). */
  async hubBars(exchange: string, token: string, from: Date, to: Date): Promise<Bar1m[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT ts, open, high, low, close, volume FROM "candles_1m"
      WHERE exchange = ${exchange} AND token = ${token}
        AND ts >= ${from.toISOString()}::timestamptz AND ts <= ${to.toISOString()}::timestamptz
      ORDER BY ts`;
    return rows.map((r) => ({ ts: (r.ts as Date).getTime(), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) }));
  }

  /** The legacy `candles` table's 1-minute bars of the same instrument (timestamps are UTC without zone). */
  async tableBars(exchange: string, token: string, from: Date, to: Date): Promise<Bar1m[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT c."timestamp" AS ts, c.open, c.high, c.low, c.close, c.volume FROM "candles" c
      JOIN "instruments" i ON i.id = c."instrumentId"
      WHERE i.exchange = ${exchange} AND i.token = ${token} AND c.timeframe = '1m' AND c."timestamp" >= ${from} AND c."timestamp" <= ${to}
      ORDER BY c."timestamp" LIMIT 20000`;
    return rows.map((r) => ({ ts: (r.ts as Date).getTime(), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) }));
  }

  /** Open ENGINE_ENTRY paper trades on `underlying`. */
  openEngineTrades(underlying: string): Promise<number> {
    return this.prisma.trade.count({
      where: { strategy: ENGINE_ENTRY_STRATEGY, isPaperTrade: true, status: { in: ['OPEN', 'PENDING'] }, entryTags: { has: `${ENGINE_UNDERLYING_TAG}${underlying.toUpperCase()}` } },
    });
  }

  /**
   * Open ENGINE_ENTRY paper trades on any of `underlyings` (the index cluster), split by direction: a bought CE is
   * bullish, a bought PE bearish (engine entries are always BUY; the option type is the instrument's, else the
   * symbol's suffix).
   */
  async openEngineByDirection(underlyings: readonly string[]): Promise<{ bullish: number; bearish: number }> {
    const rows = await this.prisma.trade.findMany({
      where: { strategy: ENGINE_ENTRY_STRATEGY, isPaperTrade: true, status: { in: ['OPEN', 'PENDING'] }, entryTags: { hasSome: underlyings.map((u) => `${ENGINE_UNDERLYING_TAG}${u.toUpperCase()}`) } },
      select: { side: true, instrument: { select: { optionType: true, symbol: true } } },
    });
    let bullish = 0;
    let bearish = 0;
    for (const r of rows) {
      const kind = String(r.instrument?.optionType ?? '').toUpperCase() || (/PE$/i.test(r.instrument?.symbol ?? '') ? 'PE' : /CE$/i.test(r.instrument?.symbol ?? '') ? 'CE' : '');
      const sell = String(r.side).toUpperCase() === 'SELL';
      if (kind === 'CE') sell ? bearish++ : bullish++;
      else if (kind === 'PE') sell ? bullish++ : bearish++;
    }
    return { bullish, bearish };
  }

  /** ENGINE_ENTRY trades created since `since` (today's count). */
  engineTradesSince(since: Date): Promise<number> {
    return this.prisma.trade.count({ where: { strategy: ENGINE_ENTRY_STRATEGY, isPaperTrade: true, createdAt: { gte: since } } });
  }

  async insertDecision(r: DecisionRow): Promise<void> {
    const inputs = JSON.stringify(r.inputs ?? {});
    const reasons = JSON.stringify(r.reasons ?? []);
    await this.prisma.$executeRaw`
      INSERT INTO "entry_engine_decisions" ("id", "underlying", "at", "action", "inputs", "reasons", "mode")
      VALUES (${r.id}, ${r.underlying}, ${r.at}, ${r.action}, ${inputs}::jsonb, ${reasons}::jsonb, ${r.mode})`;
  }

  /** The paper trade an ENTER opened (or why it did not): trade id and the reasons line appended. */
  async settleDecision(id: string, tradeId: string | null, note: string): Promise<void> {
    const extra = JSON.stringify([note]);
    await this.prisma.$executeRaw`
      UPDATE "entry_engine_decisions" SET "trade_id" = ${tradeId}, "reasons" = "reasons" || ${extra}::jsonb WHERE id = ${id}`;
  }
}
