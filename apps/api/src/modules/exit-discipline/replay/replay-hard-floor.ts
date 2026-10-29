/**
 * Hard floor replay (FLOOR_HARD_EXIT, hard-floor.ts). Pure and deterministic: walks a fixture's
 * 1-minute bars every 30 s — the live cycle's cadence — from entry to the final mark and applies the
 * SAME functions the cycle uses (hardFloorReading → confirmHardFloor) to the floor the live cycle had
 * (the newest verdict packet's money.greenFloorPrice / greenFloorArmed at or before each read). The
 * best point is the running best contract close, paired with the underlying close of that minute —
 * the cycle's own pairing (cycle-anchors.ts). The first confirmed trip is the exit the rule would
 * have recorded; it is then run through the exit gate exactly as the executor would (readPacketFacts
 * → buildGateFacts → decideExit) on that read's packet with money.anchors added.
 *
 * Unlike replayExits this needs no EXIT_NOW in the fixture: the rule does not ask the judge, which is
 * the point — 2026-10-29's 37 verdicts were all HOLD. Imports nothing outside exit-discipline.
 */
import { NOISE_LOOKBACK_MIN, STREAK_LOOKBACK_MIN, type ExitDisciplineConfig } from '../config';
import { buildGateFacts, decideExit, istDate } from '../decision';
import { exposureOf } from '../exposure';
import { confirmHardFloor, hardFloorReading, type HardFloorMemo, type HardFloorReading } from '../hard-floor';
import { noiseFromBars } from '../noise';
import { readPacketFacts } from '../packet-facts';
import type { HistoryVerdict } from '../persistence';
import type { GateRecordV1, MinuteBar, PriceAnchor } from '../types';
import type { ExitFixtureV1, FixtureVerdict } from './fixture';

export interface HardFloorReplayOptions {
  cfg: ExitDisciplineConfig;
  /** Net P&L after charges at a contract price (the trade-sentinel charges model, injected). */
  netPnl: (ltp: number) => number;
  /** Read cadence, ms (the cycle's 30 s by default). */
  stepMs?: number;
}

export interface HardFloorRead { at: string; ltp: number; underlying: number | null; floor: number | null; netPnl: number; reading: HardFloorReading }

export interface HardFloorReplayResult {
  /** Every read with a trip (confirmed or not), oldest first — the audit of when the rule saw it. */
  trips: HardFloorRead[];
  /** The confirming read: when the rule would have recorded its EXIT_NOW. Null when it never fires. */
  fired: HardFloorRead | null;
  best: PriceAnchor | null;
  /** The exit gate on the rule's EXIT_NOW (null when it never fires). */
  gate: GateRecordV1 | null;
}

const MIN = 60_000;
type Obj = Record<string, unknown>;
const o = (x: unknown): Obj | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The packet's underlying noise unit (flow.noiseUnit.value.underlying.n), when it carries one. */
function packetNu(packet: unknown): number | null {
  const b = o(o(o(packet)?.flow)?.noiseUnit);
  return b && b.available === true ? num(o(o(b.value)?.underlying)?.n) : null;
}

export function replayHardFloor(fx: ExitFixtureV1, opt: HardFloorReplayOptions): HardFloorReplayResult {
  const { meta } = fx;
  const dir = meta.side === 'LONG' ? 1 : -1;
  const step = opt.stepMs ?? 30_000;
  const exposure = exposureOf(meta.symbol, meta.side);
  const contract = [...fx.contractBars].sort((a, b) => a.ts - b.ts);
  const underlying = [...fx.underlyingBars].sort((a, b) => a.ts - b.ts);
  const verdicts = [...fx.verdicts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const barAt = (bars: MinuteBar[], t: number) => bars.find((b) => b.ts === Math.floor(t / MIN) * MIN) ?? null;
  const start = Date.parse(meta.entryAt);
  const end = Date.parse(meta.finalMark.at);

  let best: PriceAnchor | null = null;
  let memo: HardFloorMemo | null = null;
  const trips: HardFloorRead[] = [];
  let fired: HardFloorRead | null = null;
  let firedPacket: { v: FixtureVerdict; t: number } | null = null;

  for (let t = start; t <= end && !fired; t += step) {
    const c = barAt(contract, t);
    if (!c) continue;
    const ltp = c.close;
    const u = barAt(underlying, t)?.close ?? null;
    if (best === null || (ltp - best.ltp) * dir > 1e-9) best = { ltp, underlying: u, at: new Date(t).toISOString() };
    const latest = [...verdicts].reverse().find((v) => Date.parse(v.createdAt) <= t) ?? null;
    const facts = latest ? readPacketFacts(latest.packet) : null;
    const floor = facts && !('unreadable' in facts) ? facts.floor : { price: null, armed: false };
    const day = istDate(new Date(t));
    const nU = (latest ? packetNu(latest.packet) : null)
      ?? noiseFromBars(underlying.filter((b) => b.ts + MIN <= t && b.ts >= t - NOISE_LOOKBACK_MIN * MIN && istDate(new Date(b.ts)) === day))?.n
      ?? null;
    const net = opt.netPnl(ltp);
    const reading = hardFloorReading({
      side: meta.side, exposure, ltp, floor, netPnl: net, underlying: u, bestUnderlying: best.underlying, nUnderlying: nU, k: opt.cfg.floorHardExitN,
    });
    const c2 = confirmHardFloor(memo, reading.trip, t);
    memo = c2.memo;
    const read: HardFloorRead = { at: new Date(t).toISOString(), ltp, underlying: u, floor: floor.price, netPnl: net, reading };
    if (reading.trip) trips.push(read);
    if (c2.fire) {
      fired = read;
      firedPacket = latest ? { v: latest, t } : null;
    }
  }

  let gate: GateRecordV1 | null = null;
  if (fired && firedPacket) {
    // The rule verdict's packet: the live packet at that read, with this read's prices and the anchors.
    const p = JSON.parse(JSON.stringify(firedPacket.v.packet)) as Obj;
    const pos = o(p.position)!;
    const money = o(p.money)!;
    pos.ltp = fired.ltp;
    pos.underlyingLtp = { available: true, value: fired.underlying, source: 'replay', at: fired.at };
    money.netPnl = fired.netPnl;
    money.anchors = { best, floorArm: null, hardExitN: opt.cfg.floorHardExitN };
    const facts = readPacketFacts(p);
    if (!('unreadable' in facts)) {
      const now = new Date(firedPacket.t);
      const history: HistoryVerdict[] = verdicts
        .filter((v) => Date.parse(v.createdAt) < firedPacket!.t && Date.parse(v.createdAt) >= firedPacket!.t - STREAK_LOOKBACK_MIN * MIN)
        .map((v) => {
          const f = readPacketFacts(v.packet);
          const ok = !('unreadable' in f);
          return { id: v.id, verdict: v.verdict, createdAt: new Date(v.createdAt), underlying: ok ? f.underlying : null, support: ok ? f.support : null, resistance: ok ? f.resistance : null };
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const gateFacts = buildGateFacts(facts, {
        ltpNow: fired.ltp, productType: meta.productType, minutesToClose: null, maxLossPerTrade: meta.maxLossPerTrade,
        dailyLossLatched: false, history, now,
      });
      gate = decideExit({ facts: gateFacts, current: { id: 'rule', createdAt: now }, history, cfg: opt.cfg, now });
    }
  }
  return { trips, fired, best, gate };
}
