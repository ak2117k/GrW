import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { PAPER_TRACKER_PREFIX } from '../../trade-sentinel/paper/paper-tracker';
import type { InputPacketSrc, ThesisSrc } from './detectors';
import type { CarrySrc, ExitExecSrc, HoldVerdictSrc, PaperExitSrc, SignalDecisionSrc, TrackerSrc } from './ledger';
import type { Bar } from './types';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const MIN = 60_000;
const READ_MAX = 3000;
const FLOOR_JUSTIFICATIONS = new Set(['CONFIRMED_FLOOR_BREACH', 'FLOOR_HARD_EXIT']);
const refKey = (exchange: string | null | undefined, token: string | null | undefined) => `${String(exchange ?? '').toUpperCase()}:${token ?? ''}`;

/**
 * Read-only access to the tables the decision ledger is a view over (plan 2026-11-04 F2). Every query is
 * bounded by the window DecisionGradingService derives from the session; nothing here writes. Bars come
 * from candles_1m only: a missing path is UNSCORABLE, never fetched from the broker here (the 350 ms
 * historical gate is the live paths' — memory: scarce-resource ceilings).
 */
@Injectable()
export class DecisionSourcesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Finished signal decisions in [from, to) with their live order's status. */
  async signalDecisions(from: Date, to: Date): Promise<Array<SignalDecisionSrc & { orderStatus: string | null }>> {
    const rows = await this.prisma.signalDecision.findMany({
      where: { decidedAt: { gte: from, lt: to }, status: 'DONE' },
      select: { id: true, userId: true, underlying: true, decidedAt: true, mode: true, decision: true, skipReason: true, gate: true, judge: true, plan: true, aiCheck: true },
      orderBy: { decidedAt: 'asc' },
      take: READ_MAX,
    });
    const orders = rows.length ? await this.prisma.signalOrder.findMany({ where: { decisionId: { in: rows.map((r) => r.id) } }, select: { decisionId: true, status: true } }) : [];
    const statusOf = new Map(orders.map((o) => [o.decisionId, o.status]));
    return rows.map((r) => ({ ...r, orderStatus: statusOf.get(r.id) ?? null }));
  }

  /** AI exit executions in [from, to) with their outcome, tracker exit, lot size and the spike latch. */
  async exitExecutions(from: Date, to: Date): Promise<ExitExecSrc[]> {
    const rows = await this.prisma.aiExitExecution.findMany({
      where: { createdAt: { gte: from, lt: to }, status: { in: ['PLACED', 'FILLED', 'DRY_RUN', 'SKIPPED'] } },
      select: {
        id: true, userId: true, verdictId: true, trackerId: true, symbol: true, exchange: true, token: true, side: true, quantity: true, mode: true,
        status: true, reason: true, verdictReason: true, gate: true, decisionLtp: true, decisionAt: true, fillPrice: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: READ_MAX,
    });
    if (rows.length === 0) return [];
    const outcomes = await this.prisma.aiExitOutcome.findMany({
      where: { executionId: { in: rows.map((r) => r.id) } },
      select: { executionId: true, kind: true, status: true, positionSide: true, qty: true, decisionPrice: true, decisionAt: true, closeAt15: true, closeAt30: true, closeAt60: true },
    });
    const outOf = new Map(outcomes.map((o) => [o.executionId, o]));
    const realTrackers = [...new Set(rows.map((r) => r.trackerId).filter((t) => !t.startsWith(PAPER_TRACKER_PREFIX)))];
    const trackers = realTrackers.length ? await this.prisma.tradeTracker.findMany({ where: { id: { in: realTrackers } }, select: { id: true, exitPrice: true, status: true } }) : [];
    const exitOf = new Map(trackers.map((t) => [t.id, t.status === 'CLOSED' ? t.exitPrice : null]));
    // The spike latch lives in the exit verdict's packet (money.spike) — read only for floor exits.
    const floorVerdicts = rows.filter((r) => FLOOR_JUSTIFICATIONS.has(String(obj(r.gate).justification))).map((r) => r.verdictId);
    const packets = floorVerdicts.length ? await this.prisma.sentinelVerdict.findMany({ where: { id: { in: floorVerdicts } }, select: { id: true, packet: true } }) : [];
    const latched = new Set(packets.filter((p) => obj(obj(obj(p.packet).money).spike).latched === true).map((p) => p.id));
    const inst = await this.instruments(rows.map((r) => ({ exchange: r.exchange, token: r.token })));
    return rows.map((r) => {
      const i = inst.get(refKey(r.exchange, r.token));
      return {
        ...r,
        outcome: outOf.get(r.id) ?? null,
        spikeLatched: latched.has(r.verdictId),
        trackerExitPrice: exitOf.get(r.trackerId) ?? null,
        lotQty: i?.lotSize ?? null,
        underlying: i?.name ?? null,
      };
    });
  }

  /** HOLD verdicts in [from, to) on real trackers (paper looks live in paper_sentinel_looks, not here). */
  async holdVerdicts(from: Date, to: Date): Promise<HoldVerdictSrc[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: { createdAt: { gte: from, lt: to }, verdict: 'HOLD', NOT: { trackerId: { startsWith: PAPER_TRACKER_PREFIX } } },
      select: { id: true, userId: true, trackerId: true, symbol: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: READ_MAX * 3,
    });
  }

  async trackers(ids: string[]): Promise<TrackerSrc[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, symbol: true, exchange: true, token: true, qty: true } });
    const inst = await this.instruments(rows);
    return rows.map((r) => {
      const i = inst.get(refKey(r.exchange, r.token));
      return { ...r, lotQty: i?.lotSize ?? null, underlying: i?.name ?? null };
    });
  }

  /** Closed paper trades whose exit fell in [from, to). */
  async paperExits(from: Date, to: Date): Promise<PaperExitSrc[]> {
    const rows = await this.prisma.trade.findMany({
      where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: from, lt: to } },
      select: {
        id: true, userId: true, side: true, quantity: true, exitPrice: true, exitTime: true, exitReasonTag: true, strategy: true,
        instrument: { select: { symbol: true, exchange: true, token: true, lotSize: true, name: true } },
      },
      take: READ_MAX,
    });
    return rows
      .filter((r) => r.exitTime !== null)
      .map((r) => ({
        id: r.id, userId: r.userId, side: r.side, quantity: r.quantity, exitPrice: r.exitPrice, exitTime: r.exitTime as Date, exitReasonTag: r.exitReasonTag, strategy: r.strategy,
        symbol: r.instrument.symbol, exchange: r.instrument.exchange, token: r.instrument.token, lotSize: r.instrument.lotSize, underlying: r.instrument.name,
      }));
  }

  /** Carry / exit close decisions made in [from, to) (scored rows carry priceAt1015). */
  async carries(from: Date, to: Date): Promise<CarrySrc[]> {
    const rows = await this.prisma.intradayCarryDecision.findMany({
      where: { decidedAt: { gte: from, lt: to } },
      select: {
        id: true, userId: true, mode: true, istDay: true, symbol: true, exchange: true, token: true, positionSide: true, qty: true, decision: true, reason: true,
        decisionPrice: true, decidedAt: true, scoreStatus: true, priceAt1015: true, pnlCarry: true,
      },
      take: READ_MAX,
    });
    const inst = await this.instruments(rows);
    return rows.map((r) => {
      const i = inst.get(refKey(r.exchange, r.token));
      return { ...r, lotQty: i?.lotSize ?? null, underlying: i?.name ?? null };
    });
  }

  /**
   * Theses created in [from, to) on real trackers, with the stored underlying 1-min close at the
   * tracker's entry (index from INDEX_UNDERLYINGS, stock from its NSE cash row; MCX ⇒ null).
   */
  async theses(from: Date, to: Date): Promise<ThesisSrc[]> {
    const rows = await this.prisma.sentinelThesis.findMany({
      where: { createdAt: { gte: from, lt: to }, NOT: { trackerId: { startsWith: PAPER_TRACKER_PREFIX } } },
      select: { id: true, userId: true, trackerId: true, direction: true, source: true, reason: true, levelPrice: true, invalidation: true, createdAt: true },
      take: READ_MAX,
    });
    if (rows.length === 0) return [];
    const trackers = await this.prisma.tradeTracker.findMany({ where: { id: { in: rows.map((r) => r.trackerId) } }, select: { id: true, symbol: true, exchange: true, token: true, entryTime: true } });
    const tOf = new Map(trackers.map((t) => [t.id, t]));
    const inst = await this.instruments(trackers);
    const out: ThesisSrc[] = [];
    for (const r of rows) {
      const t = tOf.get(r.trackerId);
      if (!t) continue;
      const name = inst.get(refKey(t.exchange, t.token))?.name ?? null;
      const uRef = name ? await this.underlyingRef(name, t.exchange) : null;
      const u0 = uRef ? await this.closeAt(uRef.exchange, uRef.token, t.entryTime) : null;
      out.push({ ...r, symbol: t.symbol, underlying: name, underlyingAtEntry: u0 });
    }
    return out;
  }

  /** Judge packets (signal_decisions.judge.packet.market) and entry-engine inputs in [from, to). */
  async inputPackets(from: Date, to: Date, signal: ReadonlyArray<{ userId: string | null; underlying: string | null; decidedAt: Date; judge: unknown }>): Promise<InputPacketSrc[]> {
    const judge: InputPacketSrc[] = signal
      .filter((s) => obj(obj(s.judge).packet).market !== undefined)
      .map((s) => ({ source: 'judge' as const, underlying: s.underlying, at: s.decidedAt, userId: s.userId, blocks: obj(obj(s.judge).packet).market }));
    const engine = await this.prisma.entryEngineDecision.findMany({ where: { at: { gte: from, lt: to } }, select: { underlying: true, at: true, inputs: true }, take: READ_MAX * 2 });
    return [...judge, ...engine.map((e) => ({ source: 'engine' as const, underlying: e.underlying, at: e.at, userId: null, blocks: e.inputs }))];
  }

  /** Entry-engine ENTER decisions in [from, to) per underlying (event detector's "takes"). */
  async engineEnters(from: Date, to: Date): Promise<Array<{ underlying: string; at: Date }>> {
    return this.prisma.entryEngineDecision.findMany({ where: { at: { gte: from, lt: to }, action: { not: 'NO_TRADE' } }, select: { underlying: true, at: true }, take: READ_MAX });
  }

  /** The session's high − low of an index underlying over its average daily range (both in bp); null when unknown. */
  async moveOverAtr(name: string, from: Date, to: Date): Promise<number | null> {
    const ref = INDEX_UNDERLYINGS[name];
    if (!ref) return null;
    const bars = await this.bars(ref.exchange, ref.token, from, to);
    if (bars.length < 30) return null;
    const hi = Math.max(...bars.map((b) => b.high));
    const lo = Math.min(...bars.map((b) => b.low));
    const open = bars[0].close;
    const inst = await this.prisma.instrument.findFirst({ where: { token: ref.token, exchange: ref.exchange }, select: { id: true } });
    if (!inst || !(open > 0)) return null;
    const daily = await this.prisma.candle.findMany({ where: { instrumentId: inst.id, timeframe: '1d', timestamp: { lt: from } }, select: { high: true, low: true, close: true }, orderBy: { timestamp: 'desc' }, take: 14 });
    const ranges = daily.filter((b) => b.close > 0 && b.high >= b.low).map((b) => ((b.high - b.low) / b.close) * 1e4);
    if (ranges.length < 5) return null;
    const atrBp = ranges.reduce((s, x) => s + x, 0) / ranges.length;
    return atrBp > 0 ? Math.round((((hi - lo) / open) * 1e4 / atrBp) * 100) / 100 : null;
  }

  /** candles_1m bars of one contract in [from, to). */
  async bars(exchange: string, token: string, from: Date, to: Date): Promise<Bar[]> {
    const rows = await this.prisma.hubCandle1m.findMany({ where: { exchange, token, ts: { gte: from, lt: to } }, select: { ts: true, high: true, low: true, close: true }, orderBy: { ts: 'asc' }, take: 2000 });
    return rows.map((r) => ({ ts: r.ts.getTime(), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
  }

  /** The close of the 1-min bar holding `at` (or the latest within 5 min before it), else null. */
  private async closeAt(exchange: string, token: string, at: Date): Promise<number | null> {
    const minute = Math.floor(at.getTime() / MIN) * MIN;
    const row = await this.prisma.hubCandle1m.findFirst({ where: { exchange, token, ts: { gte: new Date(minute - 5 * MIN), lte: new Date(minute) } }, select: { close: true }, orderBy: { ts: 'desc' } });
    const c = row ? Number(row.close) : NaN;
    return Number.isFinite(c) && c > 0 ? c : null;
  }

  private async underlyingRef(name: string, exchange: string): Promise<{ exchange: string; token: string } | null> {
    const idx = INDEX_UNDERLYINGS[name];
    if (idx) return { exchange: idx.exchange, token: idx.token };
    if (String(exchange).toUpperCase().startsWith('MCX')) return null;
    const rows = await this.prisma.instrument.findMany({ where: { exchange: 'NSE', symbol: { in: [`${name}-EQ`, name] } }, select: { symbol: true, token: true } });
    const best = rows.sort((a, b) => (a.symbol === `${name}-EQ` ? -1 : b.symbol === `${name}-EQ` ? 1 : 0))[0];
    return best ? { exchange: 'NSE', token: best.token } : null;
  }

  private async instruments(refs: ReadonlyArray<{ exchange: string | null; token: string | null }>): Promise<Map<string, { lotSize: number; name: string | null }>> {
    const uniq = [...new Map(refs.filter((r) => r.exchange && r.token).map((r) => [refKey(r.exchange, r.token), { exchange: r.exchange as string, token: r.token as string }])).values()];
    if (uniq.length === 0) return new Map();
    const rows = await this.prisma.instrument.findMany({ where: { OR: uniq.map((r) => ({ exchange: r.exchange, token: r.token })) }, select: { exchange: true, token: true, lotSize: true, name: true } });
    return new Map(rows.map((r) => [refKey(r.exchange, r.token), { lotSize: r.lotSize, name: r.name ?? null }]));
  }
}
