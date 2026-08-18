import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeGreenFloor } from '../charges';
import { RosterService, type RosterEntry } from './roster.service';
import {
  TripwireService,
  type LastJudged,
  type TripwireResult,
} from './tripwire.service';
import {
  ContextPacketService,
  SPOT_SOURCE_CASH,
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
 * The OI wall fields are omitted as well as the latch: the cycle captures walls
 * on its own cadence and owns their provenance, so a tick source that tried to
 * supply them would be silently overwritten.
 *
 * CASH SEGMENTS: `underlyingLtp` must equal `ltp` for `EQ_DELIVERY`/`EQ_INTRADAY`,
 * because for cash the contract IS the underlying. A null there silences every
 * level-comparing sensor on every equity position — silently, since a sensor that
 * cannot see the underlying is required to stay quiet. The cycle repairs that one
 * case defensively (see `withCashUnderlying`) rather than trusting each adapter to
 * remember, but the adapter should still set it.
 */
export type TickReading = Omit<
  TickSnapshot,
  'greenFloorArmedLatched' | 'oiWallNow' | 'oiWallPrev' | 'oiWallsAt'
>;

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
 * What the agent actually saw the last time it judged this position, for the
 * material-change gate. Null when there is no prior verdict, or when the stored
 * packet does not carry the three fields — both of which correctly mean "no
 * usable baseline", and `materiallyChanged` treats that as material.
 *
 * Read from the STORED PACKET rather than from cycle state on purpose: the
 * packet is what the agent genuinely saw, it is already persisted, and it
 * survives a restart. An in-memory baseline would reset on every deploy and
 * silently degrade the gate to "always evaluate" — which is the spend it exists
 * to remove, disappearing exactly when nobody is watching for it.
 */
export function previousJudged(
  last: { packet?: unknown } | undefined | null,
): LastJudged | null {
  const packet = last?.packet as
    | { position?: { ltp?: unknown; qty?: unknown }; money?: { greenFloorArmed?: unknown } }
    | undefined;
  const ltp = packet?.position?.ltp;
  const qty = packet?.position?.qty;
  const armed = packet?.money?.greenFloorArmed;
  if (typeof ltp !== 'number' || !Number.isFinite(ltp)) return null;
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return null;
  return { ltp, qty, greenFloorArmed: armed === true };
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
  /**
   * The wall pair the agent has already been woken for, as a comparable key.
   *
   * Tripwires are pure and stateless, and `wallsFor` now serves the SAME pair
   * for up to a minute — so a genuine shift re-fires `oi-wall-shift` on every
   * tick of that window (~12 wakes at a 5s poll where the old per-tick capture
   * produced one). Suppressing the repeat is the other half of the capture-
   * cadence change; without it the fix trades a flapping cost for a sticking one.
   */
  oiEvaluatedKey: string | null;
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

    const capture = await this.wallsFor(entry, tick, now);
    const walls = capture.walls;

    const rawDecision = this.tripwires.evaluate(
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
      {
        // The LATCHED value, not `computeGreenFloor`'s per-tick snapshot — a
        // cadence that read the snapshot would oscillate with the market.
        greenFloorArmed: greenFloorArmedLatched,
        lastJudged: previousJudged(last),
        current: {
          ltp: tick.ltp,
          qty: tick.qty,
          greenFloorArmed: greenFloorArmedLatched,
        },
      },
    );

    const state = this.stateFor(entry);
    const decision = suppressRepeatWallShift(rawDecision, wallKey(walls), state.oiEvaluatedKey);

    if (!decision.shouldEvaluate) {
      report.skipped += 1;
      return;
    }

    // Placed AFTER the sensors and the OI capture, not before: those are free (or
    // already rate-limited) and keeping them running means the ratchet, the wall
    // series and the fire log stay continuous through an agent outage. What the
    // backoff suppresses is the expensive tail — thesis, packet, judge.
    //
    // Silent per tick: the window is announced once, when it is opened, in the
    // catch below. Logging here would emit ~720 lines/hour/position through an
    // outage, which buries the one line that says what actually broke.
    if (now.getTime() < state.agentRetryAt) {
      report.skipped += 1;
      return;
    }

    // Committed to looking at this wall pair. Recorded BEFORE the work rather
    // than after it, so a transient packet or agent failure does not re-wake on
    // the identical unchanged transition — the backoff owns retries, and the
    // heartbeat still guarantees a look within HEARTBEAT_INTERVAL_MS.
    state.oiEvaluatedKey = wallKey(walls);

    const thesis = await this.thesisFor(entry, tick, now);

    const packet: ContextPacket = await this.packets.build(
      entry,
      {
        ...tick,
        oiWallNow: walls.now,
        oiWallPrev: walls.prev,
        oiWallsAt: capture.at,
        greenFloorArmedLatched,
      },
      thesis,
      decision.fires,
    );

    let verdict;
    try {
      // The trigger picks the model tier. `?? 'FIRE'` keeps the expensive tier
      // as the fallback: a decision that somehow reached here without saying why
      // it woke the agent must not be quietly downgraded — see `judge`.
      verdict = await this.agent.judge(packet, decision.trigger ?? 'FIRE');
    } catch (err) {
      state.agentFailures += 1;
      const wait = agentBackoffMs(state.agentFailures);
      state.agentRetryAt = now.getTime() + wait;
      // Once per window, here — not once per suppressed tick at the gate above.
      this.logger.warn(
        `sentinel agent failed on ${entry.symbol} (${entry.trackerId}), ` +
          `${state.agentFailures} consecutive; backing off ${Math.round(wait / 1000)}s`,
      );
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
      // The thesis reads side, entry price, entry time and qty; the walls and the
      // latch are irrelevant to it. Passed as empty rather than as live cycle
      // state so the inference input stays independent of it, which matters if
      // it is ever replayed.
      oiWallNow: null,
      oiWallPrev: null,
      oiWallsAt: null,
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
        oiEvaluatedKey: null,
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
   *
   * KEYED BY `tick.structureSymbol`, NOT BY `entry.symbol`. The chain is looked
   * up by UNDERLYING — `OptionsChainService.getExpiries` matches
   * `optionChainSnapshot.underlying` exactly and `instrument.symbol CONTAINS
   * underlying` — so a tradingsymbol like `NIFTY28AUG2524000CE` matches neither
   * and `walls()` returns `[]`.
   *
   * This is the worst of the four sites that had it wrong, because of the guard
   * on the line below: `wallsFor` runs ONLY when there is an expiry, i.e. only
   * for derivatives. So the mistake did not affect a subset of positions, it
   * affected ONE HUNDRED PERCENT of the positions this method is ever invoked
   * for. And the failure was actively misleading rather than merely silent —
   * `OiWallSnapshotService` warns that an empty result is indistinguishable
   * between "cash stock with no chain", "chain fetch failed" and "service not
   * wired", so a reader would conclude the first of those about an option.
   */
  private async wallsFor(
    entry: RosterEntry,
    tick: TickReading,
    now: Date,
  ): Promise<{ walls: { now: WallPair | null; prev: WallPair | null }; at: string | null }> {
    if (!tick.expiry) return { walls: { now: null, prev: null }, at: null };
    // Same no-fallback rule as the packet and the thesis: calling with the
    // tradingsymbol is a guaranteed miss, and the miss is reported as an
    // ambiguous "no walls" that reads as a fact about the instrument.
    if (!tick.structureSymbol) return { walls: { now: null, prev: null }, at: null };

    const state = this.stateFor(entry);
    const cached = state.oi;
    if (cached && now.getTime() - cached.at < OI_CAPTURE_INTERVAL_MS) {
      // The CAPTURE time, not this tick's — the packet must not claim a
      // minute-old reading was taken just now.
      return { walls: cached.walls, at: new Date(cached.at).toISOString() };
    }

    const walls = await this.oiWalls.captureAndCompare(
      // The UNDERLYING — see the note above. This also changes the spelling of
      // the snapshot table's `symbol` key for derivatives; lineage is already
      // segregated by `expiry`, so the only effect is that any rows written
      // under the old tradingsymbol key are orphaned rather than mis-compared.
      tick.structureSymbol,
      tick.expiry,
      tick.underlyingLtp,
    );
    state.oi = { at: now.getTime(), walls };
    return { walls, at: now.toISOString() };
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

/** The sensor whose fire depends only on the wall pair, and so can repeat. */
export const OI_WALL_SHIFT = 'oi-wall-shift';

/**
 * A comparable identity for a wall pair. `null` when there are no walls, which
 * can never match a real reading and so never suppresses anything.
 */
export function wallKey(walls: { now: WallPair | null; prev: WallPair | null }): string | null {
  if (walls.now === null) return null;
  const p = walls.prev;
  return `${walls.now.callWall}/${walls.now.putWall}|${p ? `${p.callWall}/${p.putWall}` : 'none'}`;
}

/**
 * Drop an `oi-wall-shift` fire for a transition the agent has already been woken
 * for, and recompute whether anything is left worth waking it for.
 *
 * The sensors are pure and stateless by design — they answer "do these two
 * readings differ", which is the right question for a sensor and the wrong one
 * for a scheduler. Since `wallsFor` serves the same pair for up to a minute, the
 * honest answer stays "yes" for the whole window, so the de-duplication has to
 * live in the caller that knows what it has already looked at.
 *
 * Only this one sensor is de-duplicated. The others read live prices, volume or
 * news counts that move on their own between ticks; `oi-wall-shift` is the only
 * one whose entire input is a value this service deliberately holds still.
 */
export function suppressRepeatWallShift(
  decision: TripwireResult,
  key: string | null,
  evaluatedKey: string | null,
): TripwireResult {
  if (key === null || key !== evaluatedKey) return decision;

  const fires = decision.fires.filter((f) => f.name !== OI_WALL_SHIFT);
  if (fires.length === decision.fires.length) return decision;
  // The heartbeat is untouched: suppressing a repeat must never suppress the
  // scheduled look that exists to catch what the sensors miss.
  return { ...decision, fires, shouldEvaluate: fires.length > 0 || decision.heartbeat };
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
 *
 * THE PROVENANCE IS REPAIRED WITH THE VALUE, and it has to be. A tick that
 * reached here with no `underlyingLtp` carries the source and reason of whatever
 * FAILED to produce one — "broker FULL-mode quote", "could not be resolved".
 * Substituting the price while leaving those behind would put a present value
 * under a failed source: the packet would report an equity's spot as having come
 * from a broker quote that was never made, with `at` stamped and the whole thing
 * persisted verbatim for replay. A block that is present but wrong is worse than
 * one that is missing, precisely because it arrives with provenance attached.
 */
export function withCashUnderlying(tick: TickReading): TickReading {
  const isCash = tick.segment === 'EQ_DELIVERY' || tick.segment === 'EQ_INTRADAY';
  if (!isCash || Number.isFinite(tick.underlyingLtp as number)) return tick;
  return {
    ...tick,
    underlyingLtp: tick.ltp,
    underlyingLtpSource: SPOT_SOURCE_CASH,
    // The read time of `ltp` itself, which this tick does not carry — so null,
    // and the packet falls back to its own build time. Keeping a stale `at` from
    // a failed lookup would date the price to a reading that never happened.
    underlyingLtpAt: null,
    underlyingLtpReason: null,
  };
}
