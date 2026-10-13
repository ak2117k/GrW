import { estimateCharges, isDerivativeSegment, segmentFor } from '../../trade-sentinel/charges';
import { istDate } from '../execution/ledger-math';

/** Task 13b (owner request 2026-10-13): real broker F&O trades in the SP3 corpus. */
export const BROKER_CORPUS_SOURCE = 'broker:tracker';
export const BROKER_TRADE_KIND = 'BROKER_TRADE';
/** Size bound: verdicts kept per record (the newest). */
export const BROKER_VERDICTS_MAX = 50;

export interface TrackerRow {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: string;
  entryPrice: number;
  /** Signed: negative is short. */
  qty: number;
  entryTime: Date;
  exitPrice: number | null;
  exitTime: Date | null;
  status: string;
  holdingHigh: number | null;
  holdingLow: number | null;
}

export interface VerdictRow {
  id: string;
  createdAt: Date;
  verdict: string;
  confidence: string;
  thesisStatus: string;
  recoveryAvailable: boolean;
  reason: string;
  triggeredBy: unknown;
  netPnl: number;
  greenFloor: number | null;
  promptVersion: string;
}

export type BrokerSkip = 'NOT_CLOSED' | 'NOT_POSITION' | 'NOT_DERIVATIVE' | 'BAD_SHAPE';

export interface BrokerRecord {
  userId: string;
  source: typeof BROKER_CORPUS_SOURCE;
  sourceId: string;
  kind: typeof BROKER_TRADE_KIND;
  decidedAt: Date;
  symbol: string;
  exchange: string;
  instrumentType: string;
  direction: 'LONG' | 'SHORT';
  vehicle: null;
  strategyKey: string;
  strategyVersionId: null;
  setupGroupKey: string;
  featureSet: null;
  ruleScore: null;
  evidence: Record<string, unknown>;
  decision: Record<string, unknown>;
  outcome: Record<string, unknown>;
  outcomeAt: Date;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function brokerTradeRecord(t: TrackerRow, verdicts: readonly VerdictRow[]): { ok: true; record: BrokerRecord } | { ok: false; skip: BrokerSkip } {
  if (t.status !== 'CLOSED' || t.exitPrice === null || t.exitTime === null) return { ok: false, skip: 'NOT_CLOSED' };
  if (t.kind !== 'POSITION') return { ok: false, skip: 'NOT_POSITION' };
  const segment = segmentFor({ exchange: t.exchange, symbol: t.symbol, kind: t.kind });
  if (!isDerivativeSegment(segment)) return { ok: false, skip: 'NOT_DERIVATIVE' };
  const exitPrice = t.exitPrice;
  const exitTime = t.exitTime;
  if (!(t.entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(t.qty) || t.qty === 0 || exitTime.getTime() < t.entryTime.getTime()) {
    return { ok: false, skip: 'BAD_SHAPE' };
  }
  const side = t.qty > 0 ? 'LONG' : 'SHORT';
  const qty = Math.abs(t.qty);
  const sign = side === 'LONG' ? 1 : -1;
  const grossPnl = r2((exitPrice - t.entryPrice) * t.qty);
  const fees = r2(estimateCharges({ segment, entryPrice: t.entryPrice, exitPrice, qty, side }));
  const netPnl = r2(grossPnl - fees);
  const mfePrice = side === 'LONG' ? t.holdingHigh : t.holdingLow;
  const maePrice = side === 'LONG' ? t.holdingLow : t.holdingHigh;
  const excursion = (p: number | null): number | null => (p === null ? null : r2((p - t.entryPrice) * sign * qty));
  const held = verdicts
    .filter((v) => v.createdAt.getTime() >= t.entryTime.getTime() && v.createdAt.getTime() <= exitTime.getTime())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const last = held.length ? held[held.length - 1] : null;
  return {
    ok: true,
    record: {
      userId: t.userId,
      source: BROKER_CORPUS_SOURCE,
      sourceId: t.id,
      kind: BROKER_TRADE_KIND,
      decidedAt: t.entryTime,
      symbol: t.symbol,
      exchange: t.exchange,
      instrumentType: segment,
      direction: side,
      vehicle: null,
      strategyKey: 'broker:manual',
      strategyVersionId: null,
      setupGroupKey: `broker|${t.symbol.toUpperCase()}|${istDate(t.entryTime)}`,
      featureSet: null,
      ruleScore: null,
      evidence: {
        trackerId: t.id, token: t.token, segment, qty: t.qty, entryPrice: t.entryPrice,
        verdicts: held.slice(-BROKER_VERDICTS_MAX).map((v) => ({
          at: v.createdAt.toISOString(), verdict: v.verdict, confidence: v.confidence, thesisStatus: v.thesisStatus,
          recoveryAvailable: v.recoveryAvailable, reason: v.reason, triggeredBy: v.triggeredBy, netPnl: v.netPnl,
          greenFloor: v.greenFloor, promptVersion: v.promptVersion,
        })),
      },
      decision: {
        taken: true, by: 'human', reason: 'broker position (trade_trackers)', verdictCount: held.length,
        lastVerdict: last ? { at: last.createdAt.toISOString(), verdict: last.verdict, confidence: last.confidence, thesisStatus: last.thesisStatus } : null,
      },
      outcome: {
        entryPrice: t.entryPrice, exitPrice, qty: t.qty, grossPnl, fees, netPnl, win: netPnl > 0,
        mfe: excursion(mfePrice), mae: excursion(maePrice), mfePrice, maePrice,
        holdMins: Math.floor((exitTime.getTime() - t.entryTime.getTime()) / 60_000), exitedAt: exitTime.toISOString(),
      },
      outcomeAt: exitTime,
    },
  };
}
