import { contractPathFromBars, contractPathFromUnderlying, denseCover, fairCheck, type FairCheck, type FairPath } from './fair-score';
import { deltaReading, type DeltaReading } from './option-delta';
import { aiDecisionOf } from './ai-check';

/**
 * The stored records → the fair check's inputs (one reader for the live close in the paper watch and the
 * offline re-score script, so both score alike). Pure.
 */
type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const present = (b: unknown): Rec => {
  const o = obj(b);
  return o.status === 'present' ? obj(o.value) : {};
};

/** The default cap when a packet predates `caps` (SIGNAL_MAX_LOSS_PER_TRADE's default). */
export const FALLBACK_CAP = 2000;

export interface JudgeFacts {
  aiDecision: 'TAKE' | 'SKIP' | 'NONE';
  reasons: string[];
  aiSkipReason: string | null;
  /** ₹ risk of ONE lot at the plan's SL. */
  riskRupees1Lot: number | null;
  cap: number | null;
  capSource: 'packet' | 'fallback';
  signalSl: number | null;
  targets: number[];
  lotQty: number;
  tick: number;
  /** From the packet: the underlying spot / VIX at the judge's look, and any delta it already carried. */
  spot: number | null;
  vix: number | null;
  packetDelta: number | null;
  packetDeltaSource: string | null;
}

export function judgeFacts(judge: unknown, plan: unknown, fallbackLotQty: number): JudgeFacts {
  const j = obj(judge);
  const p = obj(plan);
  const pk = obj(j.packet);
  const caps = obj(pk.caps);
  const market = obj(pk.market);
  const capRead = num(caps.maxLossPerTrade);
  const lots = num(p.lots) ?? 1;
  const lotQty = num(p.lotSize) ?? (num(p.qty) !== null && lots > 0 ? (num(p.qty) as number) / lots : null) ?? fallbackLotQty;
  const risk = num(p.riskRupees);
  const noise = present(market.noise);
  const nd = obj(noise.delta);
  const late = obj(obj(obj(pk.plan).late).room);
  const packetDelta = num(nd.abs) ?? num(late.delta);
  const sl = num(p.sl);
  return {
    aiDecision: aiDecisionOf(j),
    reasons: Array.isArray(j.reasons) ? j.reasons.filter((r): r is string => typeof r === 'string') : [],
    aiSkipReason: typeof j.aiSkipReason === 'string' ? j.aiSkipReason : null,
    riskRupees1Lot: risk !== null ? Math.round((risk / (lots > 0 ? lots : 1)) * 100) / 100 : null,
    cap: capRead ?? FALLBACK_CAP,
    capSource: capRead !== null ? 'packet' : 'fallback',
    signalSl: sl !== null && sl > 0 ? sl : null,
    targets: Array.isArray(p.targets) ? p.targets.map(Number).filter((t) => Number.isFinite(t) && t > 0) : [],
    lotQty: lotQty > 0 ? lotQty : fallbackLotQty,
    tick: num(p.tickSize) ?? 0.05,
    spot: num(present(market.chain).spot) ?? num(present(market.structure).spot) ?? num(present(market.market).spot),
    vix: num(present(market.market).vix),
    packetDelta: packetDelta !== null && packetDelta !== 0 ? Math.abs(packetDelta) : null,
    packetDeltaSource: num(nd.abs) !== null ? `packet market.noise.delta (${String(nd.source ?? '')})` : num(late.delta) !== null ? 'packet plan.late.room.delta' : null,
  };
}

/** CE / PE / FUT / EQ from a trading symbol (the instrument row's optionType wins when known). */
export function kindOf(symbol: string, optionType?: string | null): 'CE' | 'PE' | 'FUT' | 'EQ' {
  const o = String(optionType ?? '').toUpperCase();
  if (o === 'CE' || o === 'PE') return o;
  const s = String(symbol ?? '').toUpperCase();
  if (/\dCE$/.test(s)) return 'CE';
  if (/\dPE$/.test(s)) return 'PE';
  if (/FUT$/.test(s)) return 'FUT';
  return 'EQ';
}

export interface PathSources {
  kind: string;
  entry: number;
  entryTs: number;
  /** The contract's own 1-min bars (broker history or candles_1m). */
  contractBars?: ReadonlyArray<{ ts: number; high: number; low: number }> | null;
  contractBarsSource?: string;
  /** The underlying's 1-min bars (candles_1m). */
  underlyingBars?: ReadonlyArray<{ ts: number; high: number; low: number; close: number }> | null;
  underlyingLabel?: string;
  delta?: DeltaReading | null;
  /** The exit shadow's STOP row (the SIGNAL stop crossed on a 30 s paper-watch LTP). */
  shadowStop?: { ts: number; price: number } | null;
}

/**
 * Contract bars first (no delta needed) when they cover the trade densely up to `exitTs` (or no exit is
 * given); else the underlying × delta when it has bars; else the sparse contract bars; else none (UNSCORABLE).
 */
export function buildFairPath(s: PathSources & { exitTs?: number | null }): FairPath | null {
  const seen = s.shadowStop ?? null;
  const cb = (s.contractBars ?? []).filter((b) => b.ts > Math.floor(s.entryTs / 60_000) * 60_000);
  const ub = s.underlyingBars ?? [];
  const contract: FairPath | null = cb.length > 0 ? { method: `contract-1m (${s.contractBarsSource ?? 'stored bars'})`, points: contractPathFromBars(cb, s.entryTs), signalStopSeen: seen, note: `${cb.length} contract 1-min bars` } : null;
  if (contract && (s.exitTs === undefined || s.exitTs === null || denseCover(contract.points, s.entryTs, s.exitTs) || ub.length === 0)) return contract;
  if (ub.length > 0) {
    if (!s.delta) return null;
    const { points, u0 } = contractPathFromUnderlying({ bars: ub, entry: s.entry, entryTs: s.entryTs, kind: s.kind, absDelta: s.delta.abs });
    if (u0 === null) return seen ? { method: 'paper-watch shadow only', points: [], signalStopSeen: seen, note: 'no underlying bar at the entry minute' } : null;
    return {
      method: s.kind === 'CE' || s.kind === 'PE' ? 'underlying-1m×delta' : 'underlying-1m (1:1)',
      points,
      signalStopSeen: seen,
      note: `${s.underlyingLabel ?? 'underlying'} 1-min bars (${points.length}), u0 ${u0} (close of the entry minute), |delta| ${s.delta.abs} — ${s.delta.source}; linear (gamma / theta ignored)`,
    };
  }
  return seen ? { method: 'paper-watch shadow only', points: [], signalStopSeen: seen, note: 'no bars: only the 30 s shadow STOP is known' } : null;
}

/** The delta for the path: the packet's, else the ladder (chain read / parity / moneyness heuristic). */
export function pathDelta(i: {
  kind: string;
  facts: Pick<JudgeFacts, 'packetDelta' | 'packetDeltaSource' | 'spot' | 'vix'>;
  chainDelta?: number | null;
  chainOtherLeg?: number | null;
  chainIv?: number | null;
  strike: number | null;
  expiry: string | Date | null;
  at: Date;
  index: boolean;
  spot?: number | null;
}): DeltaReading | null {
  if ((i.kind === 'CE' || i.kind === 'PE') && i.facts.packetDelta !== null) return { abs: i.facts.packetDelta, source: i.facts.packetDeltaSource ?? 'packet' };
  return deltaReading({
    kind: i.kind,
    read: i.chainDelta ?? null,
    readSource: 'chain snapshot greek (mbm_chain_snapshots, same expiry)',
    otherLegDelta: i.chainOtherLeg ?? null,
    spot: i.spot ?? i.facts.spot,
    strike: i.strike,
    expiry: i.expiry,
    now: i.at,
    iv: i.chainIv ?? null,
    vix: i.facts.vix,
    index: i.index,
  });
}

/** Records + path → the fair check. */
export function fairFromRecords(i: {
  judge: unknown;
  plan: unknown;
  side: string;
  entry: number | null;
  entryTs: number;
  exit: { ts: number; price: number } | null;
  fallbackLotQty: number;
  path: FairPath | null;
}): FairCheck & { capSource: 'packet' | 'fallback' } {
  const f = judgeFacts(i.judge, i.plan, i.fallbackLotQty);
  const c = fairCheck({
    aiDecision: f.aiDecision,
    side: i.side,
    entry: i.entry,
    entryTs: i.entryTs,
    exit: i.exit,
    signalSl: f.signalSl,
    targets: f.targets,
    lotQty: f.lotQty,
    cap: f.cap,
    tick: f.tick,
    path: i.path,
    judge: { reasons: f.reasons, aiSkipReason: f.aiSkipReason, riskRupees: f.riskRupees1Lot },
  });
  return { ...c, capSource: f.capSource };
}
