/**
 * Exit discipline replay engine (plan Task 18, spec §12). Pure and deterministic:
 * walks a fixture's live verdicts oldest first and runs every AI `EXIT_NOW`
 * through the SAME functions the API uses (readPacketFacts → buildGateFacts →
 * decideExit), with N, N_u and the noise-aware floor re-measured from the
 * fixture's closed 1-minute bars at each verdict's time. The first PASS (or
 * BYPASS) is the exit that would have executed. Imports nothing outside
 * exit-discipline: breakeven-after-charges is injected.
 */
import { NOISE_LOOKBACK_MIN, STREAK_LOOKBACK_MIN, type ExitDisciplineConfig } from '../config';
import { buildGateFacts, bypassRecord, decideExit, istDate } from '../decision';
import { noiseAwareFloor } from '../floor';
import { noiseFromBars, scaledUnderlyingNoise } from '../noise';
import { readPacketFacts, type PacketFacts } from '../packet-facts';
import type { HistoryVerdict } from '../persistence';
import type { FloorBasis, GateRecordV1, MinuteBar, NoiseReading } from '../types';
import type { ExitFixtureV1, FixtureVerdict } from './fixture';

export interface ReplayOptions { cfg: ExitDisciplineConfig; breakeven: (m: ExitFixtureV1['meta']) => number }
export interface ReplayDecision {
  verdictId: string; at: string; record: GateRecordV1; ltpNow: number; nContract: number | null;
  floor: { price: number | null; armed: boolean };
}
export interface ReplayResult {
  /** One per EXIT_NOW evaluated; stops after the first PASS/BYPASS. */
  decisions: ReplayDecision[];
  executed: ReplayDecision | null;
  pnl: { exitPrice: number; exitAt: string; grossRupees: number; basis: 'executed' | 'final-mark' };
  /** `passed` = decisions that would have sold (PASS, or BYPASS when off / facts unreadable). */
  counts: { gated: number; awaiting: number; passed: number };
}

const MIN = 60_000;

/** Closed bars only (bar end ≤ t), within the last `lookbackMin` minutes and the same IST day. */
function closedWindow(bars: MinuteBar[], t: number, lookbackMin: number): MinuteBar[] {
  const day = istDate(new Date(t));
  return bars.filter((b) => b.ts + MIN <= t && b.ts >= t - lookbackMin * MIN && istDate(new Date(b.ts)) === day);
}

function historyOf(prior: Array<{ v: FixtureVerdict; facts: PacketFacts | null }>, t: number): HistoryVerdict[] {
  return prior
    .filter((h) => Date.parse(h.v.createdAt) < t && Date.parse(h.v.createdAt) >= t - STREAK_LOOKBACK_MIN * MIN)
    .map((h) => ({
      id: h.v.id, verdict: h.v.verdict, createdAt: new Date(h.v.createdAt),
      underlying: h.facts?.underlying ?? null, support: h.facts?.support ?? null, resistance: h.facts?.resistance ?? null,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function replayExits(fx: ExitFixtureV1, o: ReplayOptions): ReplayResult {
  const { meta } = fx;
  const dir = meta.side === 'LONG' ? 1 : -1;
  const entryMs = Date.parse(meta.entryAt);
  const contract = [...fx.contractBars].sort((a, b) => a.ts - b.ts);
  const underlying = [...fx.underlyingBars].sort((a, b) => a.ts - b.ts);
  const verdicts = [...fx.verdicts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const be = o.breakeven(meta);
  const breakeven = Number.isFinite(be) && be > 0 ? be : null;

  // Noise floor latch (R4): armed once, level tighten-only — updated at EVERY verdict time.
  let latchedArmed = false;
  let prevArmedLevel: number | null = null;

  const prior: Array<{ v: FixtureVerdict; facts: PacketFacts | null }> = [];
  const decisions: ReplayDecision[] = [];
  const counts = { gated: 0, awaiting: 0, passed: 0 };
  let executed: ReplayDecision | null = null;

  for (const v of verdicts) {
    const t = Date.parse(v.createdAt);
    const now = new Date(t);
    const read = readPacketFacts(v.packet);
    const facts = 'unreadable' in read ? null : read;

    const n: NoiseReading | null = noiseFromBars(closedWindow(contract, t, NOISE_LOOKBACK_MIN));
    const nU: NoiseReading | null = noiseFromBars(closedWindow(underlying, t, NOISE_LOOKBACK_MIN))
      ?? scaledUnderlyingNoise(facts?.levelBookAtr15m, now.toISOString());

    const since = contract.filter((b) => b.ts >= Math.floor(entryMs / MIN) * MIN && b.ts + MIN <= t);
    const barPeak = since.length === 0 ? null
      : dir > 0 ? Math.max(...since.map((b) => b.high)) : Math.min(...since.map((b) => b.low));
    const packetPeak = mfeOf(v.packet);
    const peaks = [barPeak, packetPeak].filter((x): x is number => x !== null && Number.isFinite(x));
    const peak = peaks.length === 0 ? null : dir > 0 ? Math.max(...peaks) : Math.min(...peaks);

    let floor: { price: number | null; armed: boolean; basis: FloorBasis } | null = null;
    if (n && breakeven !== null) {
      const nf = noiseAwareFloor({
        side: meta.side, breakeven, peak, n: n.n, armN: o.cfg.floorArmN, trailN: o.cfg.floorTrailN, prevArmedLevel, latchedArmed,
      });
      if (nf.armed) {
        latchedArmed = true;
        prevArmedLevel = nf.level;
      }
      floor = { price: nf.level, armed: nf.armed, basis: 'noise' };
    }

    if (v.verdict === 'EXIT_NOW' && !executed) {
      const minute = Math.floor(t / MIN) * MIN;
      const bar = contract.find((b) => b.ts === minute);
      const ltpNow = bar ? bar.close : facts?.ltp ?? NaN;
      const usedFloor = floor ?? facts?.floor ?? { price: null, armed: false, basis: 'fixed' as const };
      let record: GateRecordV1;
      if (!o.cfg.enabled) {
        record = bypassRecord('DISABLED', o.cfg, now);
      } else if (!facts || !Number.isFinite(ltpNow)) {
        record = bypassRecord('FACTS_UNREADABLE', o.cfg, now, 'unreadable' in read ? read.unreadable : 'no LTP at the verdict');
      } else {
        const history = historyOf(prior, t);
        const gateFacts = buildGateFacts(facts, {
          ltpNow, productType: meta.productType, minutesToClose: null, maxLossPerTrade: meta.maxLossPerTrade,
          dailyLossLatched: false, history, now,
          nContractOverride: n?.n ?? null, nUnderlyingOverride: nU?.n ?? null, floorOverride: usedFloor,
        });
        record = decideExit({ facts: gateFacts, current: { id: v.id, createdAt: now }, history, cfg: o.cfg, now });
      }
      const d: ReplayDecision = {
        verdictId: v.id, at: v.createdAt, record, ltpNow, nContract: n?.n ?? null,
        floor: { price: usedFloor.price, armed: usedFloor.armed },
      };
      decisions.push(d);
      if (record.outcome === 'GATED_THESIS_INTACT') counts.gated++;
      else if (record.outcome === 'AWAITING_CONFIRMATION') counts.awaiting++;
      else {
        counts.passed++;
        executed = d;
      }
    }
    prior.push({ v, facts });
    if (executed) break;
  }

  const pnl = executed
    ? { exitPrice: executed.ltpNow, exitAt: executed.at, grossRupees: (executed.ltpNow - meta.entryPrice) * meta.qty * dir, basis: 'executed' as const }
    : { exitPrice: meta.finalMark.price, exitAt: meta.finalMark.at, grossRupees: (meta.finalMark.price - meta.entryPrice) * meta.qty * dir, basis: 'final-mark' as const };
  return { decisions, executed, pnl, counts };
}

/** `money.mfe` of a stored packet (the best price the sentinel saw), when present. */
function mfeOf(packet: unknown): number | null {
  const money = packet && typeof packet === 'object' ? (packet as Record<string, unknown>).money : null;
  const mfe = money && typeof money === 'object' ? (money as Record<string, unknown>).mfe : null;
  return typeof mfe === 'number' && Number.isFinite(mfe) ? mfe : null;
}

/** The multipliers the E6 harness may sweep. */
export type GridKey = 'floorArmN' | 'floorTrailN' | 'gateUnderlyingN' | 'persistWindowSec' | 'persistMinSec';
export const GRID_KEYS: readonly GridKey[] = ['floorArmN', 'floorTrailN', 'gateUnderlyingN', 'persistWindowSec', 'persistMinSec'];

/** Cartesian product over the given keys (GRID_KEYS order, values in the given order); base values elsewhere. */
export function gridConfigs(base: ExitDisciplineConfig, grid: Partial<Record<GridKey, number[]>>): ExitDisciplineConfig[] {
  let out: ExitDisciplineConfig[] = [base];
  for (const key of GRID_KEYS) {
    const values = grid[key];
    if (!values || values.length === 0) continue;
    out = out.flatMap((c) => values.map((x) => ({ ...c, [key]: x })));
  }
  return out;
}
