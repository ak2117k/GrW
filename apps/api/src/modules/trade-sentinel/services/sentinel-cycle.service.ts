import { Injectable, Logger } from '@nestjs/common';
import { computeGreenFloor } from '../charges';
import { RosterService, type RosterEntry } from './roster.service';
import { TripwireService } from './tripwire.service';
import {
  ContextPacketService,
  packetAsJson,
  type ContextPacket,
  type TickSnapshot,
} from './context-packet.service';
import { ThesisService, isRetryable as isRetryableThesis, type EnsuredThesis } from './thesis.service';
import { SentinelAgentService } from './sentinel-agent.service';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import { OiWallSnapshotService } from './oi-wall-snapshot.service';

export interface CycleReport {
  evaluated: number;
  skipped: number;
  failed: number;
  unwatched: number;
}

/**
 * How long a position whose thesis is the honest-unknown placeholder must wait
 * before inference is attempted again.
 *
 * `ThesisService.ensureFor` re-infers on EVERY call while the stored thesis is
 * that placeholder — one Anthropic call per call, with no cooldown of its own
 * (it says so, and it is the right default for a service that must never let a
 * failed thesis blind the watch). The cadence therefore has to be owned here,
 * because only the cycle knows how often it ticks. Set equal to
 * `HEARTBEAT_INTERVAL_MS`: while the API is down a placeholder position costs at
 * most one inference attempt per fifteen minutes rather than one per tick.
 *
 * The cooldown applies ONLY to a placeholder. A real thesis still goes through
 * `ensureFor` every evaluation — that path makes no API call, just a row read,
 * and it is how a USER correction takes effect on the very next look instead of
 * up to fifteen minutes later.
 */
export const THESIS_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * What the tick source supplies: every field of the packet's `TickSnapshot`
 * EXCEPT the green-floor latch.
 *
 * The latch is deliberately not askable of a tick source. `computeGreenFloor`
 * documents that `armed` is read off the current ltp only and that the caller
 * owns the ratchet; a per-tick reading is by definition not a ratchet. The cycle
 * is the only component that sees the same position across ticks, so the cycle
 * owns it — see {@link SentinelCycleService.armedLatch}.
 *
 * CASH SEGMENTS: `underlyingLtp` must equal `ltp` for `EQ_DELIVERY`/`EQ_INTRADAY`,
 * because for cash the contract IS the underlying. A null there silences every
 * level-comparing sensor on every equity position — silently, since a sensor that
 * cannot see the underlying is required to stay quiet. The cycle repairs that one
 * case defensively (see `withCashUnderlying`) rather than trusting each adapter to
 * remember, but the adapter should still set it.
 */
export type TickReading = Omit<TickSnapshot, 'greenFloorArmedLatched'>;

/** Supplies the per-tick numbers a tripwire needs. Implemented over trade-tracker + market-data. */
export interface TickSource {
  tickFor(trackerId: string): Promise<TickReading>;
}

/**
 * The factor readings the agent saw when it last looked at this trade, pulled
 * back out of the packet stored with that verdict.
 *
 * Returns `{}` when there is no previous verdict, or when the previous packet
 * marked the factors unavailable — in both cases `contextFactorFlip` correctly
 * cannot fire, because there is no earlier reading to have flipped away from.
 * Never throws: a malformed stored packet degrades to "no baseline", never to a
 * fabricated one.
 */
export function previousFactorValues(
  last: { packet?: unknown } | undefined | null,
): Record<string, number> {
  const macro = (last?.packet as { macro?: { realFactors?: unknown } } | undefined)?.macro;
  const block = macro?.realFactors as { available?: boolean; value?: unknown } | undefined;
  if (!block || block.available !== true) return {};

  const value = block.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  // Only finite numbers survive: a NaN baseline would manufacture a sign flip
  // on the next evaluation, which is the hazard Task 6 hardened its sensors
  // against. Absent data must not become signal on either side of the diff.
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Whether the packet stored with the previous verdict already reported the green
 * floor as armed. This is the DURABLE half of the latch — it is what survives a
 * process restart. Never throws; anything unreadable means "no evidence it ever
 * armed", which is the safe direction (the floor re-arms as soon as the position
 * clears the margin again).
 *
 * Reading only the most recent verdict is sufficient because the flag is
 * self-propagating: every packet is written with `latched || floor.armed`, so
 * once one verdict records it armed, so does every verdict after it.
 */
export function storedFloorArmed(last: { packet?: unknown } | undefined | null): boolean {
  const money = (last?.packet as { money?: { greenFloorArmed?: unknown } } | undefined)?.money;
  return money?.greenFloorArmed === true;
}

/**
 * The per-position state the cycle carries between ticks. Small and derived —
 * everything here can be rebuilt from the verdict log after a restart, which is
 * why none of it needs a table of its own.
 */
interface TrackerState {
  /** Which tenant this tracker belongs to, so the map can be pruned per user. */
  userId: string;
  /** The in-process half of the green-floor ratchet. */
  greenFloorArmed: boolean;
  /** The last thesis obtained, and when — the placeholder-retry cooldown reads this. */
  thesis: { value: EnsuredThesis; at: number } | null;
}

/**
 * Stage 0 orchestration: roster -> tripwires -> packet -> agent -> record.
 *
 * There is deliberately no executor here and no import of TradeExecutionService.
 * Shadow mode is the full system with the last wire cut, and the cut is
 * STRUCTURAL: not a `dryRun` flag, not a config key, not a boolean that a future
 * change could flip by accident or that a bug could flip by surprise. Nothing in
 * this file's dependency graph can place an order, so no code path through it
 * can either. Turning shadow mode off in Stage 1 must be a deliberate edit that
 * adds an executor and shows up in review as one.
 */
@Injectable()
export class SentinelCycleService {
  private readonly logger = new Logger(SentinelCycleService.name);

  /**
   * Per-tracker carry-over, keyed by trackerId. Pruned to the live roster at the
   * end of every run, so a closed position's state does not accumulate.
   */
  private readonly state = new Map<string, TrackerState>();

  constructor(
    private readonly roster: RosterService,
    private readonly tripwires: TripwireService,
    private readonly packets: ContextPacketService,
    private readonly thesis: ThesisService,
    private readonly agent: SentinelAgentService,
    private readonly verdicts: SentinelVerdictRepository,
    private readonly oiWalls: OiWallSnapshotService,
    private readonly ticks: TickSource,
  ) {}

  async runForUser(userId: string, now: Date = new Date()): Promise<CycleReport> {
    const entries = await this.roster.build(userId);
    const report: CycleReport = { evaluated: 0, skipped: 0, failed: 0, unwatched: 0 };

    for (const entry of entries) {
      if (!entry.watched) {
        report.unwatched += 1;
        this.logger.warn(`UNWATCHED: ${entry.symbol} (${entry.reason})`);
        continue;
      }

      // One bad position must not blind the sentinel to the other four. The
      // runner's per-sensor isolation is the inner layer of this; the whole of a
      // position's work — tick, walls, packet, agent, write — is the outer one.
      try {
        await this.evaluateOne(entry, now, report);
      } catch (err) {
        report.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`sentinel cycle failed for ${entry.symbol}: ${message}`);
      }
    }

    this.prune(userId, new Set(entries.map((e) => e.trackerId)));
    return report;
  }

  private async evaluateOne(entry: RosterEntry, now: Date, report: CycleReport): Promise<void> {
    const tick = withCashUnderlying(await this.ticks.tickFor(entry.trackerId));
    const [last] = await this.verdicts.recentForTracker(entry.trackerId, 1);

    // The ratchet is updated BEFORE the skip decision, deliberately: a floor that
    // arms on a quiet tick and pulls back before the next evaluation has still
    // armed, and the agent must not be shown it un-arming.
    const greenFloorArmedLatched = this.armedLatch(entry, tick, last);

    // Captured on every tick, evaluated or not — shift detection needs an
    // unbroken history, and a reading skipped is a shift that can never be seen.
    const walls = tick.expiry
      ? await this.oiWalls.captureAndCompare(entry.symbol, tick.expiry, tick.underlyingLtp)
      : { now: null, prev: null };

    const decision = this.tripwires.evaluate(
      {
        trackerId: entry.trackerId,
        symbol: entry.symbol,
        segment: tick.segment,
        side: tick.side,
        entryPrice: tick.entryPrice,
        qty: tick.qty,
        ltp: tick.ltp,
        underlyingLtp: tick.underlyingLtp,
        holdingHigh: tick.holdingHigh,
        holdingLow: tick.holdingLow,
        nearestSupport: tick.nearestSupport,
        nearestResistance: tick.nearestResistance,
        volumeRatio: tick.volumeRatio,
        oiWallNow: walls.now,
        oiWallPrev: walls.prev,
        freshNewsCount: tick.freshNewsCount,
        factorValues: tick.factorValues,
        // "Changed since I last LOOKED at this trade" — not since the last tick.
        // The previous verdict's stored packet already holds the factor readings
        // the agent last saw, so it is the correct baseline and needs no extra
        // state. Empty on first sight, which correctly means contextFactorFlip
        // cannot fire until there is something to compare against.
        prevFactorValues: previousFactorValues(last),
      },
      last ? last.createdAt : null,
      now,
    );

    if (!decision.shouldEvaluate) {
      report.skipped += 1;
      return;
    }

    const thesis = await this.thesisFor(entry, tick, now);

    const packet: ContextPacket = await this.packets.build(
      entry,
      { ...tick, oiWallNow: walls.now, oiWallPrev: walls.prev, greenFloorArmedLatched },
      thesis,
      decision.fires,
    );

    const verdict = await this.agent.judge(packet);

    await this.verdicts.record({
      // Taken from the entry, not from the argument: the roster carries the
      // tenant precisely so it cannot be paired with the wrong trade here.
      userId: entry.userId,
      trackerId: entry.trackerId,
      symbol: entry.symbol,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      thesisStatus: verdict.thesisStatus,
      recoveryAvailable: verdict.recoveryAvailable,
      reason: verdict.reason,
      evidence: verdict.evidence,
      invalidationPoint: verdict.invalidationPoint,
      reviewInSec: verdict.reviewIn,
      packet: packetAsJson(packet),
      // Stamped from the agent, never hardcoded: Task 13's replay attributes a
      // behaviour change to a prompt change by diffing this field, and a stale
      // literal here would make a prompt edit look like a model regression.
      promptVersion: this.agent.promptVersion,
      triggeredBy:
        decision.fires.length > 0 ? decision.fires.map((f) => f.name) : ['heartbeat'],
      netPnl: packet.money.netPnl,
      greenFloor: packet.money.greenFloorPrice,
    });

    report.evaluated += 1;
  }

  /**
   * The green-floor ratchet: once armed for a position, armed for the rest of its
   * life.
   *
   * Two layers, unioned, because neither is sufficient alone:
   *  - the DURABLE layer, read from the packet stored with the last verdict, is
   *    what survives a process restart, but it only records ticks that actually
   *    produced a verdict;
   *  - the IN-PROCESS layer catches an arming that happened on a tick the
   *    tripwires skipped, which the durable layer would never have seen.
   *
   * Union, never replacement — the latch may only ever move from false to true.
   */
  private armedLatch(
    entry: RosterEntry,
    tick: TickReading,
    last: { packet?: unknown } | undefined,
  ): boolean {
    const state = this.stateFor(entry);
    const armedNow = computeGreenFloor({
      segment: tick.segment,
      entryPrice: tick.entryPrice,
      ltp: tick.ltp,
      qty: tick.qty,
      side: tick.side,
    }).armed;

    state.greenFloorArmed = state.greenFloorArmed || armedNow || storedFloorArmed(last);
    return state.greenFloorArmed;
  }

  /**
   * The thesis for this position, honouring {@link THESIS_RETRY_COOLDOWN_MS}.
   *
   * Only a placeholder is held back — `isRetryable` is the same predicate the
   * thesis service uses to decide whether to re-infer, so this cooldown suppresses
   * exactly the calls that would have made an API request and nothing else.
   */
  private async thesisFor(
    entry: RosterEntry,
    tick: TickReading,
    now: Date,
  ): Promise<EnsuredThesis> {
    const state = this.stateFor(entry);
    const cached = state.thesis;
    if (
      cached &&
      isRetryableThesis(cached.value) &&
      now.getTime() - cached.at < THESIS_RETRY_COOLDOWN_MS
    ) {
      return cached.value;
    }

    // `TickSnapshot` is what the thesis service reads; the latch is irrelevant to
    // it (it looks at side, entry price, entry time, qty), so any value would do —
    // `false` is passed rather than the live latch to keep the inference input
    // independent of cycle state, which matters if it is ever replayed.
    const thesis = await this.thesis.ensureFor(entry, {
      ...tick,
      greenFloorArmedLatched: false,
    });
    state.thesis = { value: thesis, at: now.getTime() };
    return thesis;
  }

  private stateFor(entry: RosterEntry): TrackerState {
    let state = this.state.get(entry.trackerId);
    if (!state) {
      state = { userId: entry.userId, greenFloorArmed: false, thesis: null };
      this.state.set(entry.trackerId, state);
    }
    return state;
  }

  /** Drop carry-over for this user's trackers that are no longer on the roster. */
  private prune(userId: string, live: Set<string>): void {
    for (const [trackerId, state] of this.state) {
      if (state.userId === userId && !live.has(trackerId)) this.state.delete(trackerId);
    }
  }
}

/**
 * For a cash position the contract IS the underlying, so `underlyingLtp` must be
 * `ltp`. A null there is not a stated absence, it is a hole: every sensor that
 * compares a price against a level is REQUIRED to stay silent without an
 * underlying (see the SCALE HAZARD note on `TripwireInput`), so an equity tick
 * that forgets this field turns `levelBreak` off on every equity position and
 * looks exactly like "the level was never touched".
 *
 * Only cash is repaired. For OPT/FUT the spot genuinely is a separate number and
 * a missing one must stay missing — substituting the premium there would compare
 * 120 against a 24000 level and read as a permanent breach.
 */
export function withCashUnderlying(tick: TickReading): TickReading {
  const isCash = tick.segment === 'EQ_DELIVERY' || tick.segment === 'EQ_INTRADAY';
  if (!isCash || Number.isFinite(tick.underlyingLtp as number)) return tick;
  return { ...tick, underlyingLtp: tick.ltp };
}
