import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { OiWallSnapshotService, type WallPair } from './oi-wall-snapshot.service';

export interface CycleReport {
  evaluated: number;
  /**
   * Watched, but not evaluated on this tick. Three causes, all logged and all
   * deliberate: no sensor fired and the heartbeat was not due; the agent is in
   * its failure backoff; the position is waiting out neither and simply had
   * nothing to say. "Skipped" is the absence of a verdict, never the absence of
   * attention — the ratchet and the OI series keep running underneath it.
   */
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
 * because only the cycle knows how often it ticks. While the API is down a
 * placeholder position costs at most one inference attempt per fifteen minutes
 * rather than one per tick.
 *
 * Held at or above `HEARTBEAT_INTERVAL_MS` rather than pinned equal to it: the
 * safe invariant is one-sided. Lowering the heartbeat must never drag the retry
 * cooldown down with it and multiply the cost of an outage.
 *
 * The cooldown applies ONLY to a placeholder — a real thesis goes through
 * `ensureFor` on every evaluation, which is one row read and no API call. For
 * the staleness this DOES impose on a correction, and why that is accepted
 * rather than fixed here, see `TrackerState.thesis`.
 */
export const THESIS_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * The agent-failure backoff: `AGENT_RETRY_BASE_MS * 2^(consecutive failures - 1)`,
 * capped at `AGENT_RETRY_MAX_MS`. So 30s, 1m, 2m, 4m, 8m, then 15m forever.
 *
 * `SentinelAgentService.judge` throws on a refusal, an unparseable reply, a
 * truncated one, a verdict citing evidence that is not in the packet, an
 * `EXIT_NOW` below high confidence, and a non-positive `reviewIn`. Every one of
 * those aborts the position's evaluation, so NO VERDICT ROW IS WRITTEN — and a
 * position with no verdict row has `lastVerdictAt === null`, which makes the
 * heartbeat permanently due. Without this the next tick calls `judge` again
 * immediately: at a 5-second poll that is ~720 failed agent calls per hour per
 * position, each preceded by a packet build, for as long as the failure lasts.
 * It is the same amplification `THESIS_RETRY_COOLDOWN_MS` exists for, on the
 * call that costs roughly a hundred times more.
 *
 * EXPONENTIAL rather than the thesis path's flat interval, because the failure
 * distribution is different. A thesis placeholder means inference has already
 * failed and is being retried on a schedule. An agent throw is more often a
 * one-off — one malformed reply, one rate-limit spike — and making a position
 * wait a full heartbeat to recover from a single bad reply would be its own
 * kind of blindness. So the first retry is quick (30s) and only a genuinely
 * SYSTEMATIC failure decays to the heartbeat rate. No jitter: five positions per
 * user is far too few for a thundering herd to matter, and determinism is worth
 * more here because these intervals are what a replay has to reproduce.
 */
export const AGENT_RETRY_BASE_MS = 30 * 1000;
export const AGENT_RETRY_MAX_MS = 15 * 60 * 1000;

/**
 * How often the OI walls are actually captured, independent of the poll rate.
 *
 * `OiWallSnapshotService` reads `prev` as the immediately preceding STORED row,
 * and the table is durable — so skipping a capture never makes a shift
 * invisible, it makes `prev` OLDER and the comparison window WIDER. Capturing
 * every tick therefore does the opposite of protecting the sensor: it pins
 * `oiWallPrev` to the reading from a few seconds ago, so `oiWallShift` can only
 * ever see a single-tick strike flip. Its threshold is 0.2%, and one Nifty
 * strike step at 24000 is 0.208% — just over — so a wall flapping between two
 * near-equal-OI strikes would fire the sensor on roughly every other tick and
 * wake the agent continuously.
 *
 * A minute is ample at strike granularity, and it puts the OI baseline on the
 * same footing as `prevFactorValues`: both answer "what has changed since a
 * meaningful earlier look", not "since the last few seconds".
 */
export const OI_CAPTURE_INTERVAL_MS = 60 * 1000;

/**
 * DI token for {@link TickSource}. It is an interface, so `design:paramtypes`
 * emits `Object` for it and Nest cannot resolve the parameter by type — without
 * an explicit token, Task 12 could not register the adapter without editing this
 * file.
 */
export const TICK_SOURCE = 'SENTINEL_TICK_SOURCE';

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
  /**
   * The last thesis obtained, and when.
   *
   * STALENESS BOUND — read this before trusting a thesis downstream. While the
   * cached thesis is the honest-unknown placeholder, the cycle holds off calling
   * `ensureFor` for up to {@link THESIS_RETRY_COOLDOWN_MS}. A USER correction
   * made during that window is therefore NOT seen until the window lapses: the
   * gate reads the CACHED value, and the cache cannot know a row it did not
   * read has changed. So the guarantee is narrower than "corrections land at
   * once" — it is:
   *
   *   - thesis on record is real  -> `ensureFor` runs on every look (one row
   *     read, no API call), so a correction lands on the very next look;
   *   - thesis on record is the placeholder -> a correction lands within
   *     {@link THESIS_RETRY_COOLDOWN_MS}.
   *
   * Accepted rather than fixed, because the only correct fix is invalidation at
   * the WRITE — `ThesisService.correct` telling the cycle to drop this entry —
   * and wiring a controller-driven write back into a polling service is Task
   * 12's composition problem, not something to hard-code here. The delay is
   * bounded, it only affects a position whose thesis was already unknown, and
   * the stale value it serves is the placeholder, which explicitly says it is
   * unknown. Worth doing properly in Stage 1; not worth a back-channel now.
   */
  thesis: { value: EnsuredThesis; at: number } | null;
  /** Consecutive `judge` failures, driving the exponential backoff. */
  agentFailures: number;
  /** Epoch ms before which the agent must not be called again. 0 when clear. */
  agentRetryAt: number;
  /** The last OI capture and when, so capture is decoupled from the poll rate. */
  oi: { at: number; walls: { now: WallPair | null; prev: WallPair | null } } | null;
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

  /** Trackers already warned about a missing cash underlying — warn once, not per tick. */
  private readonly warnedMissingUnderlying = new Set<string>();

  constructor(
    private readonly roster: RosterService,
    private readonly tripwires: TripwireService,
    private readonly packets: ContextPacketService,
    private readonly thesis: ThesisService,
    private readonly agent: SentinelAgentService,
    private readonly verdicts: SentinelVerdictRepository,
    private readonly oiWalls: OiWallSnapshotService,
    @Inject(TICK_SOURCE) private readonly ticks: TickSource,
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

    this.prune(
      // Prune on the tenants the ENTRIES claim, not only on the argument: an
      // entry whose userId differs from the argument stores its state under that
      // userId, and pruning on the argument alone would never reach it. The
      // argument is included so that an EMPTY roster — every position closed —
      // still clears this user's state.
      new Set([userId, ...entries.map((e) => e.userId)]),
      new Set(entries.map((e) => e.trackerId)),
    );
    return report;
  }

  /**
   * OWNERSHIP IS NOT A GATE HERE, DELIBERATELY. An `OBSERVE_ONLY` entry — a
   * holding, or a position another engine already manages — is evaluated and its
   * verdict recorded exactly like a `SENTINEL` one. Stage 0 exists to measure the
   * quality of the judgement, and discarding the judgements on a third of the
   * roster would measure it on a biased sample.
   *
   * What that costs is that the agent can return `EXIT_NOW` on a holding the
   * roster describes as "observed, never closed". Harmless while nothing can
   * execute — but it is only harmless because of that, so the packet carries
   * `position.ownership` and every verdict is attributable to it. Two readers
   * depend on that: Task 13 must be able to score acted-upon and never-actionable
   * verdicts separately, and STAGE 1 MUST KEY ITS EXECUTOR OFF `ownership`, NOT
   * OFF `watched` — watched means "worth looking at", never "ours to close".
   */
  private async evaluateOne(entry: RosterEntry, now: Date, report: CycleReport): Promise<void> {
    const raw = await this.ticks.tickFor(entry.trackerId);
    const tick = withCashUnderlying(raw);
    // Identity, not value: `withCashUnderlying` returns the same object when it
    // had nothing to repair. A tick source that never sets `underlyingLtp` would
    // otherwise look permanently healthy behind the repair.
    if (tick !== raw) this.warnMissingUnderlying(entry);

    const [last] = await this.verdicts.recentForTracker(entry.trackerId, 1);

    // The ratchet is updated BEFORE the skip decision, deliberately: a floor that
    // arms on a quiet tick and pulls back before the next evaluation has still
    // armed, and the agent must not be shown it un-arming.
    const greenFloorArmedLatched = this.armedLatch(entry, tick, last);

    const walls = await this.wallsFor(entry, tick, now);

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

    // Placed AFTER the sensors and the OI capture, not before: those are free (or
    // already rate-limited) and keeping them running means the ratchet, the wall
    // series and the fire log stay continuous through an agent outage. What the
    // backoff suppresses is the expensive tail — thesis, packet, judge.
    const state = this.stateFor(entry);
    if (now.getTime() < state.agentRetryAt) {
      report.skipped += 1;
      this.logger.warn(
        `sentinel agent backing off ${entry.symbol} (${entry.trackerId}) after ` +
          `${state.agentFailures} consecutive failures; next attempt in ` +
          `${Math.ceil((state.agentRetryAt - now.getTime()) / 1000)}s`,
      );
      return;
    }

    const thesis = await this.thesisFor(entry, tick, now);

    const packet: ContextPacket = await this.packets.build(
      entry,
      { ...tick, oiWallNow: walls.now, oiWallPrev: walls.prev, greenFloorArmedLatched },
      thesis,
      decision.fires,
    );

    let verdict;
    try {
      verdict = await this.agent.judge(packet);
    } catch (err) {
      state.agentFailures += 1;
      state.agentRetryAt = now.getTime() + agentBackoffMs(state.agentFailures);
      throw err;
    }
    // A verdict came back and passed validation, so whatever was wrong has
    // cleared. Reset before the write: the write failing is a database problem,
    // and punishing the agent for it would back off the wrong component.
    // Resetting the COUNTER is what matters, and it is why the backoff is over
    // consecutive failures rather than lifetime ones: without it, an occasional
    // bad reply spread over a long session would eventually silence a perfectly
    // healthy position for fifteen minutes at a time.
    state.agentFailures = 0;
    // Clearing the deadline is belt-and-braces — this line is only reachable when
    // `now >= agentRetryAt`, so the deadline is already in the past and cannot
    // gate a later tick. Kept because it makes the "no backoff pending" state
    // representable rather than merely unreachable.
    state.agentRetryAt = 0;

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
      state = {
        userId: entry.userId,
        greenFloorArmed: false,
        thesis: null,
        agentFailures: 0,
        agentRetryAt: 0,
        oi: null,
      };
      this.state.set(entry.trackerId, state);
    }
    return state;
  }

  /**
   * The OI walls for this tick, captured at {@link OI_CAPTURE_INTERVAL_MS} rather
   * than at the poll rate, and reused from the last capture in between.
   *
   * Reusing rather than returning nulls between captures matters: a null pair
   * would make `oiWallShift` see the walls appear and disappear, and the packet
   * would report "no options chain for this symbol" on a symbol that plainly has
   * one. The sensors see a slightly older reading; they never see a hole.
   */
  private async wallsFor(
    entry: RosterEntry,
    tick: TickReading,
    now: Date,
  ): Promise<{ now: WallPair | null; prev: WallPair | null }> {
    if (!tick.expiry) return { now: null, prev: null };

    const state = this.stateFor(entry);
    const cached = state.oi;
    if (cached && now.getTime() - cached.at < OI_CAPTURE_INTERVAL_MS) return cached.walls;

    const walls = await this.oiWalls.captureAndCompare(
      entry.symbol,
      tick.expiry,
      tick.underlyingLtp,
    );
    state.oi = { at: now.getTime(), walls };
    return walls;
  }

  private warnMissingUnderlying(entry: RosterEntry): void {
    if (this.warnedMissingUnderlying.has(entry.trackerId)) return;
    this.warnedMissingUnderlying.add(entry.trackerId);
    this.logger.warn(
      `tick for ${entry.symbol} (${entry.trackerId}) arrived with no underlyingLtp on a cash ` +
        'segment; the cycle set it to ltp so the level sensors can still see. The tick source ' +
        'should be setting it — for cash the contract IS the underlying.',
    );
  }

  /** Drop carry-over for these tenants' trackers that are no longer on the roster. */
  private prune(owners: Set<string>, live: Set<string>): void {
    for (const [trackerId, state] of this.state) {
      if (owners.has(state.userId) && !live.has(trackerId)) {
        this.state.delete(trackerId);
        this.warnedMissingUnderlying.delete(trackerId);
      }
    }
  }
}

/** See {@link AGENT_RETRY_BASE_MS}. Exported so the backoff shape is testable directly. */
export function agentBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  // Shift rather than Math.pow, and cap the exponent: 2 ** 1024 is Infinity, and
  // an Infinity retry time would take the position offline permanently.
  const exponent = Math.min(consecutiveFailures - 1, 20);
  return Math.min(AGENT_RETRY_BASE_MS * 2 ** exponent, AGENT_RETRY_MAX_MS);
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
