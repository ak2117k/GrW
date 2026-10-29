import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { computeGreenFloor } from '../charges';
import { RosterService, type RosterEntry } from './roster.service';
import {
  TripwireService,
  heartbeatDue,
  type HeartbeatContext,
  type LastJudged,
  type TripwireResult,
} from './tripwire.service';
import type { TripwireFire } from '../tripwires/types';
import {
  ContextPacketService,
  SPOT_SOURCE_CASH,
  istWallClock,
  minutesToSessionClose,
  packetAsJson,
  type ContextPacket,
  type PacketReview,
  type TickSnapshot,
} from './context-packet.service';
import {
  JUDGE_GATE_CONFIG,
  hardRiskWindow,
  isAdverseMove,
  exitTriggerCrossed,
  gateJudgement,
  type GateFacts,
  type JudgeGateConfig,
} from './judge-gate';
import { ThesisService, isRetryable as isRetryableThesis, type EnsuredThesis } from './thesis.service';
import { SentinelAgentService } from './sentinel-agent.service';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import { exitTriggerRecord } from './exit-trigger-proposal';
import { shadowSummary } from './news-events-blocks';
import { TickSensorBook, sensorSeed } from './tick-sensor-book';
import type { Prisma } from '@prisma/client';
import { OiWallSnapshotService, type WallPair } from './oi-wall-snapshot.service';
import {
  EXIT_CONFIRM_MAX_RELOOKS,
  EXIT_DISCIPLINE_CONFIG,
  parseExitDisciplineConfig,
  type ExitDisciplineConfig,
} from '../../exit-discipline/config';
import { exitConfirmFire } from '../tripwires/exit-confirm';
import { solveCycleFloor } from './cycle-floor';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { instrumentKeysOf, newsPositionOf } from '../../news-events/keys';
import { MARKET_EVENTS, type EventsReader } from '../ports/events.port';
import type { TripwireInput } from '../tripwires/types';
import { NewsWatchBook } from './news-watch-book';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import {
  REJUDGE_CONFIG,
  SUPPRESSIBLE_FIRES,
  rejudgeSnapshot,
  suppressRepeatJudgements,
  type RejudgeConfig,
  type RejudgeSnapshot,
} from './rejudge-suppression';
import {
  EXIT_ATTEMPTS,
  FUTILE_REJUDGE_CONFIG,
  HELD_LOG_EVERY_MS,
  exitBlocked,
  isHeldPosition,
  suppressFutileJudgements,
  type BlockedExitMemo,
  type ExitAttempt,
  type ExitAttemptReader,
  type FutileCause,
  type FutileRejudgeConfig,
} from './futile-rejudge';

/** What the cycle reads from its roster. */
export type CycleRoster = Pick<RosterService, 'build'>;
/** What the cycle reads and writes of its verdict store. */
export type CycleVerdicts = Pick<SentinelVerdictRepository, 'record' | 'recentForTracker'>;

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
 * How many judgements (thesis + packet + `judge` + verdict write) may be in
 * flight at once, across every user and position this process watches.
 *
 * WHY JUDGEMENTS ARE DETACHED AT ALL. They used to be awaited inside the
 * per-position loop, so one `judge` call bounded the whole user's cycle. Under
 * `SENTINEL_JUDGE=cli` a call spawns the `claude` CLI and routinely takes
 * minutes (its timeout is 180 s, per attempt); on 2026-10-09 one user's cycle
 * ran from 21:54:30 to past 22:07 IST, and for all of it the runner's overlap
 * guard skipped every 30-second tick — so every OTHER watched position lost
 * even its cheap sensor pass, the green-floor latch and the OI capture, while
 * one position waited on a model.
 *
 * Small on purpose: two CLI processes is what a local subscription tolerates,
 * and with the API transport it still beats the old effective rate of one at a
 * time per user. A position that wants a judgement while the cap is full is
 * SKIPPED, not queued — its packet would be stale by the time a slot freed, and
 * the next tick re-reads the market and asks again.
 */
export const JUDGE_CONCURRENCY = 2;

/**
 * Slots of {@link JUDGE_CONCURRENCY} that overnight-review work may never take.
 *
 * LIVE ALWAYS GOES FIRST, by reservation rather than by priority. Live
 * judgements are dispatched only on the 30-second tick, while a queued review is
 * woken the instant a slot frees — so without a reservation a 15:45 queue of
 * two dozen equity reviews would refill every freed slot first and keep MCX's
 * live judgements (tripwire fires included) waiting for many minutes. A priority
 * scheme would instead have to hold freed slots idle until the next tick;
 * reserving is stateless and guarantees every tick finds a free slot unless LIVE
 * work fills it. The price is that reviews run one at a time.
 */
export const LIVE_RESERVED_SLOTS = 1;

/** Thrown by {@link SentinelCycleService.runShared} for a queued job whose moment has passed. */
export class SharedJobExpired extends Error {
  constructor() {
    super('shared judgement expired before it got a slot (its venue opened) — not run');
  }
}

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

/**
 * `closedSession`: the overnight review is reading a market that has CLOSED, so
 * the live staleness refusal must not apply — the last print is returned with
 * its time in `ltpAt`. A missing price is still refused.
 */
/** The tracker columns a tick reading is built from (see SentinelTickSource.tickForRow). */
export interface TickRow {
  userId: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: string;
  entryPrice: number;
  /** Signed: negative is a short. */
  qty: number;
  entryTime: Date;
  holdingHigh: number | null;
  holdingLow: number | null;
  lastLtp: number | null;
  /** The age of `lastLtp` (see the note on the tracker read). */
  updatedAt: Date;
}

export interface TickOptions {
  closedSession?: boolean;
}

/** Supplies the per-tick numbers a tripwire needs. Implemented over trade-tracker + market-data. */
export interface TickSource {
  tickFor(trackerId: string, opts?: TickOptions): Promise<TickReading>;
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
 *
 * Given `entryPrice`, a packet that recorded a DIFFERENT entry price is not
 * evidence: its floor was solved from another cost basis. This is what voids a
 * latch armed while the tracker carried entry 0 (an overnight F&O position
 * whose cost the tracker had not read) once that entry is repaired. A packet
 * that recorded no entry price is read as before.
 */
export function storedFloorArmed(last: { packet?: unknown } | undefined | null, entryPrice?: number): boolean {
  const packet = last?.packet as
    | { position?: { entryPrice?: unknown }; money?: { greenFloorArmed?: unknown; floorBasis?: unknown } }
    | undefined;
  const storedEntry = packet?.position?.entryPrice;
  if (entryPrice !== undefined && typeof storedEntry === 'number' && storedEntry !== entryPrice) return false;
  // Exit discipline: with floorBasis 'noise' the flag is the NOISE floor's arming, not
  // the ₹150 latch's — never evidence for the fixed floor (the mirror of storedNoiseFloor).
  if (packet?.money?.floorBasis === 'noise') return false;
  return packet?.money?.greenFloorArmed === true;
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
   * The entry price the ratchet was armed against. A change (a tracker whose
   * zero entry was repaired from the broker's cost) voids the latch: a floor
   * solved from another cost basis is not this position's floor.
   */
  greenFloorEntry?: number;
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
  /**
   * Sensor fires that were never put in front of the agent: they fired while
   * this position's judgement was already in flight (and were not part of it),
   * or while the concurrency cap was full. Merged into the NEXT judgement this
   * position gets — and they make it want one — so a fire is delayed, never lost.
   * Written only by the sensor pass, which is also where judgements are dispatched.
   */
  carriedFires: TripwireFire[];
  /**
   * Epoch ms of the cycle `now` at which this position first wanted a judgement
   * and was refused a slot; null when it is not waiting. The fairness tie-break
   * after "last judged" — see {@link SentinelCycleService.startForUser}.
   */
  wantedSince: number | null;
  /**
   * Exit discipline §4: the in-process half of the noise-floor ratchet (armed,
   * the last armed level, the entry it was armed against). The durable half is
   * the last live packet — see `storedNoiseFloor`.
   */
  noiseFloor: { armed: boolean; level: number | null; entry: number | null };
  /** News & events v2 edge-trigger memory (R4): fresh own-instrument article ids already fired on. */
  newsSeen?: Set<string>;
  /** News & events v2 edge-trigger memory (R4): event ids already fired (or, in observe, logged) as event-near. */
  eventsFired?: Set<string>;
  /** News & events v2 edge-trigger memory (R4): epoch ms of the last news-hit fire, for the cooldown. */
  lastNewsFireAt?: number;
  /**
   * Re-judge suppression: per suppressible fire name, the state when a judgement
   * on that fire was last RECORDED. See rejudge-suppression.ts.
   */
  rejudge?: Record<string, RejudgeSnapshot>;
  /** Futile re-judge: the blocking exit attempt last seen and the qty then. See futile-rejudge.ts. */
  blockedExit?: BlockedExitMemo;
  /** Futile re-judge: epoch ms the held-position line was last logged (once per 30 min). */
  heldLoggedAt?: number;
  /**
   * Judge gate: fresh headline ids already put in front of the judge (recorded
   * once a judgement is RECORDED). Pruned to the currently fresh ids each pass, so
   * it stays small. Memory only: a restart costs at most one repeat look.
   */
  newsJudged?: Set<string>;
}

/** Discipline off: used when no EXIT_DISCIPLINE_CONFIG is bound, so the cycle behaves exactly as before. */
const DISCIPLINE_OFF = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });

/** Futile re-judge, per pass: the latest exit attempt per tracker (one read) and what was suppressed. */
interface FutilePass {
  attempts: Map<string, ExitAttempt>;
  tally: Partial<Record<FutileCause, number>>;
}

/** A position the sensor pass decided to judge, waiting for the dispatch phase. */
interface JudgeCandidate {
  index: number;
  entry: RosterEntry;
  state: TrackerState;
  tick: TickReading;
  walls: { now: WallPair | null; prev: WallPair | null };
  wallsAt: string | null;
  greenFloorArmedLatched: boolean;
  decision: TripwireResult;
  /** When the agent last judged it (its latest verdict row), or null if never. */
  lastJudgedAt: number | null;
  /** This pass's re-judge baseline, stored for the fires judged once the verdict is recorded. */
  rejudgeSnap: RejudgeSnapshot;
  /** Judge gate: the packet's held marker / sinceLastVerdict delta (undefined ⇒ the build call is unchanged). */
  review?: PacketReview;
  /** Judge gate: the fresh headline ids this judgement shows, marked judged once it is recorded. */
  newsIds?: string[];
}

/** One judgement in flight: its promise, and the fire names it was asked about. */
interface InFlight {
  job: Promise<JudgeOutcome>;
  fires: Set<string>;
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

  /**
   * Judgements in flight, keyed by trackerId — AT MOST ONE PER POSITION.
   *
   * Deliberately NOT part of `TrackerState`: `prune` drops a tracker's state when
   * it leaves the roster, and a position that left and came back while its old
   * judgement was still running must not get a second one beside it. An entry
   * is removed only when its own job settles. Its size is the global count
   * {@link JUDGE_CONCURRENCY} caps.
   *
   * THE STATE-OWNERSHIP SPLIT that makes detaching safe. While a job is in flight
   * it is the ONLY writer of its position's `thesis`, `agentFailures` and
   * `agentRetryAt`; the per-tick sensor pass writes only `greenFloorArmed`, `oi`
   * and `oiEvaluatedKey`, and merely READS `agentRetryAt`. The two never write the
   * same field, and one-in-flight-per-position means two jobs never do either.
   */
  private readonly judging = new Map<string, InFlight>();

  /** Overnight reviews waiting for a slot — see {@link runShared}. */
  private readonly slotWaiters: Array<() => void> = [];

  /** When the concurrency cap was last reported, so a full cap logs once a minute, not per tick. */
  private capReportedAt = 0;

  constructor(
    // Narrowed to what the cycle calls, with the class as the DI token, so the paper
    // sentinel (paper/paper-sentinel.service.ts) can run this SAME cycle over its own
    // roster and its own look table — never sentinel_verdicts.
    @Inject(RosterService) private readonly roster: CycleRoster,
    private readonly tripwires: TripwireService,
    private readonly packets: ContextPacketService,
    private readonly thesis: ThesisService,
    private readonly agent: SentinelAgentService,
    @Inject(SentinelVerdictRepository) private readonly verdicts: CycleVerdicts,
    private readonly oiWalls: OiWallSnapshotService,
    @Inject(TICK_SOURCE) private readonly ticks: TickSource,
    // Part B (price triggers, R14): per-tracker context for price-only sensors on
    // hub ticks between passes. Optional so specs and a module without it are unaffected.
    @Optional() private readonly sensorBook?: TickSensorBook,
    // Exit discipline (docs/superpowers/specs/2026-10-14-exit-discipline-design.md).
    // Optional: absent ⇒ discipline off, the fixed floor and the 40 % giveback as before.
    @Optional() @Inject(EXIT_DISCIPLINE_CONFIG) private readonly discipline?: ExitDisciplineConfig,
    // News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md). All
    // optional: absent ⇒ the sensor input is exactly today's (no new keys).
    @Optional() private readonly newsWatch?: NewsWatchBook,
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly newsCfg?: NewsEventsConfig,
    @Optional() @Inject(MARKET_EVENTS) private readonly events?: EventsReader,
    // Re-judge suppression. Optional: absent ⇒ off, every repeat fire wakes the judge as before.
    @Optional() @Inject(REJUDGE_CONFIG) private readonly rejudgeCfg?: RejudgeConfig,
    // Futile re-judge suppression (held positions, exits that cannot run). Optional:
    // absent ⇒ off. The reader is a READ-ONLY view of ai_exit_executions.
    @Optional() @Inject(FUTILE_REJUDGE_CONFIG) private readonly futileCfg?: FutileRejudgeConfig,
    @Optional() @Inject(EXIT_ATTEMPTS) private readonly exitAttempts?: ExitAttemptReader,
    // Judge gate (held heartbeat-only, the 15-min rate cap + its bypasses, tier
    // upgrade, the packet delta). Optional: absent ⇒ off, exactly as before.
    @Optional() @Inject(JUDGE_GATE_CONFIG) private readonly gateCfg?: JudgeGateConfig,
  ) {}

  /**
   * One full cycle, judgements included: resolves only once every judgement this
   * pass started has been recorded (or has failed), with them counted in the
   * report. Kept for callers that want a finished cycle — tests, a manual run.
   * The scheduler uses {@link startForUser} so a slow judgement cannot hold up
   * the next tick.
   */
  async runForUser(userId: string, now: Date = new Date()): Promise<CycleReport> {
    return (await this.startForUser(userId, now)).settled;
  }

  /**
   * The cheap per-tick pass — roster, tick, latch, OI capture, sensors — with
   * every judgement it decides on DISPATCHED rather than awaited.
   *
   * Resolves as soon as the sensor pass is done. `report` counts what that pass
   * settled (skipped, unwatched, failed ticks); `pending` judgements were started
   * and are counted into `settled`'s report — evaluated or failed — when they
   * finish. `settled` never rejects. Rejects only when the roster cannot be read,
   * exactly like {@link runForUser}.
   */
  async startForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ report: CycleReport; pending: number; settled: Promise<CycleReport> }> {
    const entries = await this.roster.build(userId);
    const report: CycleReport = { evaluated: 0, skipped: 0, failed: 0, unwatched: 0 };
    const jobs: Array<Promise<JudgeOutcome>> = [];
    const candidates: JudgeCandidate[] = [];
    const suppressed: Record<string, number> = {};
    const futile: FutilePass = { attempts: await this.exitAttemptsFor(entries, now), tally: {} };

    for (const [index, entry] of entries.entries()) {
      if (!entry.watched) {
        report.unwatched += 1;
        this.logger.warn(`UNWATCHED: ${entry.symbol} (${entry.reason})`);
        continue;
      }

      // One bad position must not blind the sentinel to the other four. The
      // runner's per-sensor isolation is the inner layer of this; the whole of a
      // position's work — tick, walls, packet, agent, write — is the outer one.
      try {
        const candidate = await this.evaluateOne(entry, index, now, report, suppressed, futile);
        if (candidate) candidates.push(candidate);
      } catch (err) {
        report.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`sentinel cycle failed for ${entry.symbol}: ${message}`);
      }
    }

    // Re-judge suppression: ONE aggregated line per pass, never one per position.
    const suppressedTotal = Object.values(suppressed).reduce((a, b) => a + b, 0);
    if (suppressedTotal > 0) {
      const by = Object.entries(suppressed).map(([k, v]) => `${k}=${v}`).join(', ');
      this.logger.log(`[rejudge] suppressed ${suppressedTotal} unchanged repeat wake(s) for user ${userId} (${by})`);
    }
    const futileTotal = Object.values(futile.tally).reduce((a, b) => a + b, 0);
    if (futileTotal > 0) {
      const by = Object.entries(futile.tally).map(([k, v]) => `${k}=${v}`).join(', ');
      this.logger.log(`[rejudge] suppressed ${futileTotal} futile wake(s) for user ${userId} (${by})`);
    }

    this.prune(
      // Prune on the tenants the ENTRIES claim, not only on the argument: an
      // entry whose userId differs from the argument stores its state under that
      // userId, and pruning on the argument alone would never reach it. The
      // argument is included so that an EMPTY roster — every position closed —
      // still clears this user's state.
      new Set([userId, ...entries.map((e) => e.userId)]),
      new Set(entries.map((e) => e.trackerId)),
      // Part B: only WATCHED entries keep a tick-sensor context — an unwatched one
      // is skipped by every pass, so a tick wake for it would be a wasted pass.
      new Set(entries.filter((e) => e.watched).map((e) => e.trackerId)),
    );

    // DISPATCH, MOST URGENT AND LONGEST-WAITING FIRST. Slots are scarce
    // (JUDGE_CONCURRENCY) and skipped rather than queued, so whoever is offered a
    // free slot first wins it. Offered in roster order, the first rows would take
    // every slot freed and a later position could wait indefinitely. So: a
    // position with a FIRE (fresh or carried) ahead of heartbeat-only ones — a
    // broken level outranks a routine look — and within each group never judged
    // first, then the oldest last verdict, then whoever has been refused a slot
    // the longest; roster order only breaks a full tie.
    const fired = (c: JudgeCandidate) => (c.decision.fires.length > 0 ? 0 : 1);
    candidates.sort(
      (a, b) =>
        fired(a) - fired(b) ||
        (a.lastJudgedAt ?? -Infinity) - (b.lastJudgedAt ?? -Infinity) ||
        (a.state.wantedSince ?? now.getTime()) - (b.state.wantedSince ?? now.getTime()) ||
        a.index - b.index,
    );
    for (const c of candidates) {
      if (this.judging.size >= JUDGE_CONCURRENCY) {
        // Skipped, not queued: see JUDGE_CONCURRENCY. `oiEvaluatedKey` is NOT
        // recorded — the agent was not woken, so an unseen wall shift can still
        // wake it — and the fires are carried so the next judgement includes them.
        report.skipped += 1;
        c.state.carriedFires = mergeFires(c.state.carriedFires, c.decision.fires);
        c.state.wantedSince ??= now.getTime();
        this.reportCapFull(c.entry);
        continue;
      }
      jobs.push(this.dispatch(c, now));
    }

    const sensed: CycleReport = { ...report };
    const settled = Promise.all(jobs).then((outcomes) => {
      const final: CycleReport = { ...sensed };
      for (const outcome of outcomes) final[outcome] += 1;
      return final;
    });
    return { report, pending: jobs.length, settled };
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
  private async evaluateOne(
    entry: RosterEntry,
    index: number,
    now: Date,
    report: CycleReport,
    suppressedTally: Record<string, number> = {},
    futile: FutilePass = { attempts: new Map(), tally: {} },
  ): Promise<JudgeCandidate | null> {
    const raw = await this.ticks.tickFor(entry.trackerId);
    const tick = withCashUnderlying(raw);
    // Identity, not value: `withCashUnderlying` returns the same object when it
    // had nothing to repair. A tick source that never sets `underlyingLtp` would
    // otherwise look permanently healthy behind the repair.
    if (tick !== raw) this.warnMissingUnderlying(entry);

    // Exit discipline §5: the giveback sensor's noise rule, for this pass AND the
    // hub-tick sensors. Null when off or unmeasured (⇒ the 40 % rule, as before).
    const noiseInput =
      this.discipline?.enabled && tick.noise?.contract
        ? { n: tick.noise.contract.n, armN: this.discipline.floorArmN, givebackN: this.discipline.givebackN }
        : null;

    // Part B: the price-only sensors' context for hub ticks between passes. Memory only.
    const seed = this.sensorBook ? sensorSeed(entry, tick, noiseInput) : null;
    if (seed) this.sensorBook!.upsert(seed);

    // News & events v2: which open positions the push-wake service may wake (memory only).
    if (this.newsWatch && this.newsCfg?.computing && tick.structureSymbol) {
      const p = newsPositionOf(tick.structureSymbol, entry.exchange, tick.expiry);
      if (!('unresolved' in p)) {
        this.newsWatch.upsert({
          trackerId: entry.trackerId,
          userId: entry.userId,
          symbol: entry.symbol,
          exchange: String(entry.exchange).toUpperCase(),
          instrumentKeys: instrumentKeysOf(p),
        });
      }
    }

    // LIVE-ONLY: an overnight-review row is not a live look (see recentForTracker).
    // With exit discipline on, enough rows to count a run of EXIT_NOWs for the
    // exit-confirm re-look (§7); otherwise exactly the one row, as before.
    const recent = await this.verdicts.recentForTracker(
      entry.trackerId,
      this.discipline?.enabled ? EXIT_CONFIRM_MAX_RELOOKS + 1 : 1,
      { liveOnly: true },
    );
    const last = recent[0];

    // The ratchet is updated BEFORE the skip decision, deliberately: a floor that
    // arms on a quiet tick and pulls back before the next evaluation has still
    // armed, and the agent must not be shown it un-arming.
    const greenFloorArmedLatched = this.armedLatch(entry, tick, last);

    // Exit discipline §4: the noise-aware floor, ratcheted like the latch above
    // (in-process memory + the last live packet). Null when discipline is off or
    // N is unknown — the fixed floor then stays in charge, exactly as before.
    const floorSolve = solveCycleFloor({
      cfg: this.discipline ?? DISCIPLINE_OFF,
      segment: tick.segment,
      side: tick.side,
      entryPrice: tick.entryPrice,
      qty: tick.qty,
      holdingHigh: tick.holdingHigh,
      holdingLow: tick.holdingLow,
      nContract: tick.noise?.contract?.n ?? null,
      memory: this.stateFor(entry).noiseFloor,
      last,
    });
    this.stateFor(entry).noiseFloor = floorSolve.memory;
    const tickF: TickReading = { ...tick, noiseFloor: floorSolve.noiseFloor };
    // What the heartbeat cadence reads: the noise floor's latch when it is in
    // charge, else the fixed one.
    const armedForCadence = floorSolve.noiseFloor ? floorSolve.noiseFloor.armed : greenFloorArmedLatched;

    const capture = await this.wallsFor(entry, tick, now);
    const walls = capture.walls;

    // News & events v2 sensor inputs: {} unless NEWS_EVENTS_V2_ENABLED=true.
    const newsIn = this.newsInputs(entry, tick, this.stateFor(entry), now);
    const tripwireIn: TripwireInput = {
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
        // Exit discipline §5: the giveback sensor's noise rule. Spread only when
        // on and measured, so with discipline off the input is exactly today's
        // (absent ⇒ the 40 % rule).
        ...(noiseInput ? { noise: noiseInput } : {}),
        // News & events v2: present only with the flag `true` (edge-triggered
        // news-hit, event-near); otherwise no key — exactly today's input.
        ...newsIn,
      };
    const lastVerdictAt = last ? last.createdAt : null;
    const heartbeatContext: HeartbeatContext = {
        // The LATCHED value, not `computeGreenFloor`'s per-tick snapshot — a
        // cadence that read the snapshot would oscillate with the market.
        greenFloorArmed: armedForCadence,
        lastJudged: previousJudged(last),
        current: {
          ltp: tick.ltp,
          qty: tick.qty,
          greenFloorArmed: armedForCadence,
        },
      };
    const rawDecision = this.tripwires.evaluate(tripwireIn, lastVerdictAt, now, heartbeatContext);

    // Edge-triggered fires are spent only when they can reach the judge: inside the
    // agent-failure backoff (checked below) this pass is dropped, not carried, so the
    // headline / event must stay unseen and fire again once the backoff ends.
    if (now.getTime() >= this.stateFor(entry).agentRetryAt) this.markNewsFired(this.stateFor(entry), rawDecision.fires, newsIn, now);

    const state = this.stateFor(entry);
    // Exit discipline §7: an EXIT_NOW executes only once confirmed by a second
    // verdict, and nothing else guarantees one soon — so while the latest live
    // verdict is EXIT_NOW, ask again after PERSIST_MIN_SEC (at most 3 in a row).
    const confirm = this.discipline?.enabled
      ? exitConfirmFire({ recent, now, relookMs: this.discipline.persistMinSec * 1000, maxRelooks: EXIT_CONFIRM_MAX_RELOOKS })
      : null;
    // Re-judge suppression sits BEFORE carried fires and exit-confirm: a carried
    // fire never reached the judge and an exit-confirm re-look is the EXIT_NOW
    // confirmation path, so neither may be dropped here.
    // Judge gate facts (null when the gate is off ⇒ every input below is exactly as before).
    const gate = this.gateCfg?.enabled
      ? this.gateFactsFor(entry, state, tickF, floorSolve.noiseFloor, greenFloorArmedLatched, last, now)
      : null;
    const rejudgeSnap: RejudgeSnapshot = {
      ...rejudgeSnapshot(tick, noiseInput?.n ?? null, now.getTime()),
      ...(gate ? gate.snap : {}),
    };
    const deduped = suppressRepeatWallShift(rawDecision, wallKey(walls), state.oiEvaluatedKey);
    const rejudged = this.rejudgeCfg
      ? suppressRepeatJudgements(deduped, state.rejudge ?? {}, rejudgeSnap, this.rejudgeCfg, gate?.reviewDue)
      : { decision: deduped, suppressed: [] as string[] };
    for (const name of rejudged.suppressed) suppressedTally[name] = (suppressedTally[name] ?? 0) + 1;
    // Futile re-judge suppression (futile-rejudge.ts): on a HELD position, or one
    // whose last exit attempt hit a broker-auth/read wall or OWNER_HOLD, drop the
    // fires and the exit-confirm re-look — unless a NEW-risk sensor fired — and
    // keep only the heartbeat, at its normal cadence.
    const cause = this.futileCause(entry, state, tick.qty, futile.attempts.get(entry.trackerId), now);
    const futiled = suppressFutileJudgements(
      withCarriedFires(rejudged.decision, state.carriedFires),
      confirm,
      cause,
      this.futileCfg,
      () => heartbeatDue(tripwireIn, lastVerdictAt, now, heartbeatContext),
    );
    if (cause && futiled.suppressed.length > 0) {
      futile.tally[cause] = (futile.tally[cause] ?? 0) + 1;
      if (cause === 'held' && now.getTime() - (state.heldLoggedAt ?? Number.NEGATIVE_INFINITY) >= HELD_LOG_EVERY_MS) {
        state.heldLoggedAt = now.getTime();
        this.logger.log(`[rejudge] held position — fires suppressed: ${entry.symbol} (tracker ${entry.trackerId}; ${futiled.suppressed.join(', ')}); heartbeat kept`);
      }
    }
    // Judge gate (judge-gate.ts): held ⇒ heartbeat only, ≤ 1 per 30 min; the rate
    // cap with its safety bypasses; a routine wake on an exit candidate or under
    // risk is raised to the strong tier.
    const gated = gate
      ? gateJudgement(
          futiled.decision,
          { ...gate.facts, carried: new Set(state.carriedFires.map((f) => f.name)) },
          this.gateCfg,
          () => heartbeatDue(tripwireIn, lastVerdictAt, now, heartbeatContext),
        )
      : null;
    if (gated?.dropped) {
      const key = gated.dropped === 'cap' ? 'rate-cap' : 'held-gate';
      suppressedTally[key] = (suppressedTally[key] ?? 0) + 1;
      // Carried fires were merged into this wake; what is still owed the judge stays carried.
      state.carriedFires = gated.carry;
      this.logger.debug(
        `[judge-gate] ${gated.dropped} — ${entry.symbol} (tracker ${entry.trackerId}): dropped ${gated.suppressed.join(', ')}` +
          (gated.carry.length > 0 ? `; carried ${gated.carry.map((f) => f.name).join(', ')}` : ''),
      );
    }
    const decision = gated ? gated.decision : futiled.decision;

    if (!decision.shouldEvaluate) {
      report.skipped += 1;
      return null;
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
      return null;
    }

    // ONE JUDGEMENT PER POSITION. The one in flight was asked about this
    // position already; a second beside it would judge an overlapping packet,
    // write a second verdict row and race the first for the backoff counters.
    // Its verdict lands when it lands, and the next tick re-reads it as `last`.
    // A fire the running judgement was NOT asked about is carried, not dropped.
    const inFlight = this.judging.get(entry.trackerId);
    if (inFlight) {
      report.skipped += 1;
      state.carriedFires = mergeFires(
        state.carriedFires,
        decision.fires.filter((f) => !inFlight.fires.has(f.name)),
      );
      return null;
    }

    return {
      index,
      entry,
      state,
      // Carries the noise floor, so the packet's money block IS that floor.
      tick: tickF,
      walls,
      wallsAt: capture.at,
      greenFloorArmedLatched,
      decision,
      lastJudgedAt: last ? new Date(last.createdAt).getTime() : null,
      rejudgeSnap,
      ...(gate ? { review: gate.review, newsIds: gate.newsIds } : {}),
    };
  }

  /**
   * The judge gate's view of this position on this pass: the cap's bypass facts,
   * the extra material-change fields for the re-judge snapshot, the verdict's
   * review time, and the packet's held marker / delta. Never throws on odd data —
   * an unreadable stored packet or trigger simply contributes nothing.
   */
  private gateFactsFor(
    entry: RosterEntry,
    state: TrackerState,
    tick: TickReading,
    noiseFloor: TickSnapshot['noiseFloor'] | null | undefined,
    greenFloorArmedLatched: boolean,
    last: SentinelVerdictLike | undefined,
    now: Date,
  ): {
    facts: Omit<GateFacts, 'carried'>;
    snap: Partial<RejudgeSnapshot>;
    reviewDue: boolean | undefined;
    review: PacketReview | undefined;
    newsIds: string[];
  } {
    const cfg = this.gateCfg!;
    const nowMs = now.getTime();
    const dir = tick.side === 'LONG' ? 1 : -1;
    const green = computeGreenFloor({ segment: tick.segment, entryPrice: tick.entryPrice, ltp: tick.ltp, qty: tick.qty, side: tick.side });

    // Armed floor breached: the noise floor when it is in charge, else the latched fixed floor.
    const floorLevel = noiseFloor ? (noiseFloor.armed ? noiseFloor.level : null) : greenFloorArmedLatched ? green.floorPrice : null;
    const floorBreached =
      floorLevel !== null && Number.isFinite(floorLevel) && Number.isFinite(tick.ltp) && (tick.ltp - floorLevel) * dir < 0;

    // The latest live verdict's machine-readable exit level.
    const triggerCrossed = exitTriggerCrossed(last?.exitTrigger, tick);

    // Hard-risk windows the cycle can see: the last minutes of the session (not for
    // delivery holdings; for intraday cash, counted to the broker's MIS square-off)
    // and of expiry day. Max-loss and the daily-loss latch live in the executor's
    // gate and the core risk manager, mechanically.
    const mtc = minutesToSessionClose(now, entry.exchange);
    const left = mtc.available ? mtc.value : null;
    const expiryToday = tick.expiry !== null && tick.expiry === istWallClock(now).slice(0, 10);
    const hardRisk = hardRiskWindow(cfg, tick.segment, left, expiryToday);

    // An adverse move since the last judgement, while losing. Segment-aware: cash
    // equity is measured in its own noise units (see isAdverseMove).
    const prev = previousJudged(last);
    const adverseMove =
      prev !== null && green.netPnl < 0 &&
      isAdverseMove(cfg, { segment: tick.segment, prevLtp: prev.ltp, ltp: tick.ltp, dir, noiseN: tick.noise?.contract?.n });

    // News: which fresh headline ids the judge has not been shown yet.
    const items = tick.freshNews ?? tick.freshNewsItems ?? null;
    const judged = (state.newsJudged ??= new Set<string>());
    if (items) {
      const live = new Set(items.map((i) => i.id));
      for (const id of [...judged]) if (!live.has(id)) judged.delete(id);
    }
    const unjudged = items ? items.filter((i) => !judged.has(i.id)) : [];

    // level-break: the level the underlying is beyond.
    const u = tick.underlyingLtp;
    const lvl = tick.side === 'LONG' ? tick.nearestSupport : tick.nearestResistance;
    const level = u !== null && lvl !== null && Number.isFinite(u) && Number.isFinite(lvl) && (u - lvl) * dir < 0 ? lvl : null;

    const lastAt = last ? new Date(last.createdAt) : null;
    const reviewInSec = typeof last?.reviewInSec === 'number' && last.reviewInSec > 0 ? last.reviewInSec : null;
    const reviewDue = lastAt && reviewInSec !== null ? nowMs - lastAt.getTime() >= reviewInSec * 1000 : undefined;

    const held = isHeldPosition(cfg.hold, entry);
    const stored = last?.packet as
      | { position?: { ltp?: unknown; underlyingLtp?: { available?: unknown; value?: unknown } } }
      | undefined;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const since =
      cfg.packetDelta && last && lastAt
        ? {
            verdict: String(last.verdict),
            at: lastAt,
            reviewInSec,
            ltp: num(stored?.position?.ltp),
            underlyingLtp: stored?.position?.underlyingLtp?.available === true ? num(stored.position.underlyingLtp.value) : null,
            netPnl: num(last.netPnl),
            triggersThen: Array.isArray(last.triggeredBy) ? (last.triggeredBy as unknown[]).map(String) : [],
            newHeadlines: unjudged.map((i) => i.title),
          }
        : null;
    const review: PacketReview | undefined =
      held || since ? { ...(held ? { held: true } : {}), ...(since ? { since } : {}) } : undefined;

    return {
      facts: {
        nowMs,
        last: last && lastAt ? { verdict: String(last.verdict), createdAt: lastAt } : null,
        held,
        hardRisk,
        floorBreached,
        triggerCrossed,
        adverseMove,
      },
      snap: {
        level,
        newsUnjudged: items ? unjudged.length : null,
        newsCount: tick.freshNewsCount,
        floorBreached,
        triggerCrossed,
        hardRisk,
      },
      reviewDue,
      review,
      newsIds: unjudged.map((i) => i.id),
    };
  }

  /**
   * Futile re-judge: the latest exit attempt per open tracker, in ONE read per
   * pass. Empty (⇒ no exit-blocked suppression) when the rule is off, no reader
   * is bound, or the read fails — fails OPEN, never blocks the pass.
   */
  private async exitAttemptsFor(entries: RosterEntry[], now: Date): Promise<Map<string, ExitAttempt>> {
    const watchedEntries = entries.filter((e) => e.watched);
    if (!this.futileCfg?.enabled || !this.exitAttempts || watchedEntries.length === 0) return new Map();
    try {
      return await this.exitAttempts.latestSince(
        [...new Set(watchedEntries.map((e) => e.userId))],
        watchedEntries.map((e) => e.trackerId),
        new Date(now.getTime() - this.futileCfg.cooldownMs),
      );
    } catch (err) {
      this.logger.warn(`[rejudge] exit-attempt read failed; no exit-blocked suppression this pass: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }

  /** Why judging this position again cannot change anything right now, or null. Updates the qty memo. */
  private futileCause(
    entry: RosterEntry,
    state: TrackerState,
    qty: number,
    attempt: ExitAttempt | undefined,
    now: Date,
  ): FutileCause | null {
    const cfg = this.futileCfg;
    if (!cfg?.enabled) return null;
    if (isHeldPosition(cfg.hold, entry)) return 'held';
    const blocked = exitBlocked(attempt, state.blockedExit, qty, now.getTime(), cfg);
    state.blockedExit = blocked.memo;
    return blocked.blocked ? 'exit-blocked' : null;
  }

  /** Start one candidate's judgement detached, and register it as in flight. */
  private dispatch(c: JudgeCandidate, now: Date): Promise<JudgeOutcome> {
    const { entry, state } = c;
    // Committed to looking at this wall pair. Recorded BEFORE the work rather
    // than after it, so a transient packet or agent failure does not re-wake on
    // the identical unchanged transition — the backoff owns retries, and the
    // heartbeat still guarantees a look within HEARTBEAT_INTERVAL_MS.
    state.oiEvaluatedKey = wallKey(c.walls);
    // Whatever was carried is in `c.decision.fires` now; it has been delivered.
    state.carriedFires = [];
    state.wantedSince = null;

    const job = this.judgeDetached(
      entry,
      state,
      c.tick,
      c.walls,
      c.wallsAt,
      c.greenFloorArmedLatched,
      c.decision,
      now,
      c.review,
    );
    const inFlight: InFlight = { job, fires: new Set(c.decision.fires.map((f) => f.name)) };
    this.judging.set(entry.trackerId, inFlight);
    // `job` never rejects (see judgeDetached), so this cannot leave an
    // unhandled rejection behind; the entry is freed only by ITS OWN job.
    void job.then((outcome) => {
      // Re-judge baseline: only a RECORDED judgement counts as "the judge was
      // asked" — a failed one leaves the fire free to wake it after the backoff.
      if (outcome === 'evaluated') {
        for (const f of c.decision.fires) {
          if (SUPPRESSIBLE_FIRES.has(f.name)) (state.rejudge ??= {})[f.name] = c.rejudgeSnap;
        }
        // Judge gate: these headlines have now been in front of the judge.
        if (c.newsIds?.length) for (const id of c.newsIds) (state.newsJudged ??= new Set<string>()).add(id);
      }
      if (this.judging.get(entry.trackerId) === inFlight) this.judging.delete(entry.trackerId);
      this.wakeSlotWaiters();
    });
    return job;
  }

  /**
   * Run `work` — an overnight-review judgement — under the SAME cap and the SAME
   * one-in-flight-per-position rule as the live judgements.
   *
   * It QUEUES rather than skips, which is the one deliberate difference. A live
   * judgement refused a slot is asked again 30 seconds later with a fresher
   * packet; an overnight window that skipped would lose the position's review
   * for the night. So a review that arrives while the cap is full (or while a
   * live judgement on that position is running) waits until a slot frees, then
   * registers itself in `judging` — where a live tick sees it, counts it against
   * {@link JUDGE_CONCURRENCY}, and skips that position (carrying any fire) just
   * as it would for a live judgement in flight.
   *
   * Rejects with `work`'s own error; the slot is freed either way.
   */
  async runShared<T>(
    trackerId: string,
    work: () => Promise<T>,
    opts: { expired?: () => boolean; reserveLive?: () => boolean } = {},
  ): Promise<T> {
    // Never the last free slot(s): see LIVE_RESERVED_SLOTS. And checked on every
    // wake: a pre-open job still queued when its venue opens is dropped.
    for (;;) {
      if (opts.expired?.()) throw new SharedJobExpired();
      // The reservation only matters while live judging can happen: when every
      // venue the book holds is shut (08:30, after the closes) the caller says so
      // and overnight work may use every slot. Default: reserve.
      const reserved = (opts.reserveLive?.() ?? true) ? LIVE_RESERVED_SLOTS : 0;
      const room = this.judging.size < JUDGE_CONCURRENCY - reserved;
      if (room && !this.judging.has(trackerId)) break;
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    let settle!: (outcome: JudgeOutcome) => void;
    const inFlight: InFlight = {
      job: new Promise<JudgeOutcome>((resolve) => {
        settle = resolve;
      }),
      fires: new Set(),
    };
    this.judging.set(trackerId, inFlight);
    try {
      const out = await work();
      settle('evaluated');
      return out;
    } catch (err) {
      settle('failed');
      throw err;
    } finally {
      if (this.judging.get(trackerId) === inFlight) this.judging.delete(trackerId);
      this.wakeSlotWaiters();
    }
  }

  /** Every waiter re-checks; whoever finds room first takes the slot. */
  private wakeSlotWaiters(): void {
    for (const resolve of this.slotWaiters.splice(0)) resolve();
  }

  /**
   * The expensive tail — thesis, packet, `judge`, verdict write — for one
   * position, run DETACHED from the per-tick pass. Never rejects: the outcome is
   * returned for the report, and a failure is logged with the symbol exactly as
   * the cycle's own per-position catch did when this ran inline.
   *
   * `state` is the object captured at dispatch, never re-looked-up: if the
   * position is pruned meanwhile, this writes into an orphan rather than
   * resurrecting a map entry for a closed trade.
   */
  private async judgeDetached(
    entry: RosterEntry,
    state: TrackerState,
    tick: TickReading,
    walls: { now: WallPair | null; prev: WallPair | null },
    wallsAt: string | null,
    greenFloorArmedLatched: boolean,
    decision: TripwireResult,
    now: Date,
    review?: PacketReview,
  ): Promise<JudgeOutcome> {
    // The wall clock at dispatch, so a failure can be dated by when it HAPPENED.
    const dispatchedWall = Date.now();
    const progress = { stage: 'thesis' };
    try {
      await this.judgeAndRecord(entry, state, tick, walls, wallsAt, greenFloorArmedLatched, decision, now, progress, review);
      return 'evaluated';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`sentinel cycle failed for ${entry.symbol}: ${message}`);
      // ANY FAILED JUDGEMENT BACKS THE POSITION OFF — the thesis, the packet,
      // `judge` or the verdict write. Backing off only on `judge` used to be
      // right ("do not punish the agent for a Postgres problem"), but with
      // detached judgements and scarce slots a failure that writes no verdict
      // and opens no backoff leaves the position looking NEVER JUDGED, so it
      // wins a slot every tick and two of them starve every other position.
      state.agentFailures += 1;
      const wait = agentBackoffMs(state.agentFailures);
      // FROM THE FAILURE, NOT THE DISPATCH. A judge call can take minutes (the
      // CLI's timeout is 180 s per attempt); measured from dispatch, a 30 s or 1 m
      // backoff has already elapsed when the failure lands, so a broken CLI or an
      // expired token turns into back-to-back multi-minute calls on every
      // position, forever. The failure instant is the dispatching tick's `now`
      // advanced by the wall-clock time the call took — kept on the cycle's clock
      // so it compares with the `now` later ticks gate on — in whole seconds, which
      // is all a 30 s tick can resolve.
      const tookMs = Math.max(0, Math.floor((Date.now() - dispatchedWall) / 1000) * 1000);
      state.agentRetryAt = now.getTime() + tookMs + wait;
      // Once per window, here — not once per suppressed tick at the gate.
      this.logger.warn(
        `sentinel judgement failed at ${progress.stage} on ${entry.symbol} (${entry.trackerId}), ` +
          `${state.agentFailures} consecutive; backing off ${Math.round(wait / 1000)}s`,
      );
      return 'failed';
    }
  }

  private async judgeAndRecord(
    entry: RosterEntry,
    state: TrackerState,
    tick: TickReading,
    walls: { now: WallPair | null; prev: WallPair | null },
    wallsAt: string | null,
    greenFloorArmedLatched: boolean,
    decision: TripwireResult,
    now: Date,
    progress: { stage: string },
    review?: PacketReview,
  ): Promise<void> {
    const thesis = await this.thesisFor(entry, state, tick, now);
    progress.stage = 'packet';

    const packetTick = {
      ...tick,
      oiWallNow: walls.now,
      oiWallPrev: walls.prev,
      oiWallsAt: wallsAt,
      greenFloorArmedLatched,
    };
    // The 5th argument only when the judge gate supplies one: absent ⇒ the call is exactly as before.
    const packet: ContextPacket = review
      ? await this.packets.build(entry, packetTick, thesis, decision.fires, review)
      : await this.packets.build(entry, packetTick, thesis, decision.fires);
    // News & events v2 OBSERVE: what the packet WOULD carry — stored beside the
    // verdict, never shown to the judge. Optional call: a packets double without it
    // is "off". It must never cost the verdict, so a throw is logged and dropped.
    const newsShadow = this.newsShadowFor(entry, packetTick, now);

    progress.stage = 'judge';
    // The trigger picks the model tier. `?? 'FIRE'` keeps the expensive tier
    // as the fallback: a decision that somehow reached here without saying why
    // it woke the agent must not be quietly downgraded — see `judge`. A throw
    // here (or anywhere in this method) is backed off in `judgeDetached`.
    const verdict = await withAiCallContext({ userId: entry.userId, positionId: entry.trackerId }, () =>
      this.agent.judge(packet, decision.trigger ?? 'FIRE'),
    );
    // A verdict came back and passed validation, so whatever was wrong has
    // cleared. Reset before the write; if the write then fails, `judgeDetached`
    // counts that as one fresh failure and backs off from 30 s.
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

    // Price triggers: the judge's level and the instrument it watches. DATA ONLY —
    // arming, validation and execution all live in sentinel-executor (ruling R1).
    const exitTrigger = exitTriggerRecord(verdict, tick);
    if (newsShadow) this.logger.log(`[news-shadow] ${entry.symbol} ${verdict.verdict}: ${shadowSummary(newsShadow as never)}`);

    progress.stage = 'verdict write';
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
      ...(exitTrigger ? { exitTrigger: exitTrigger as unknown as Prisma.InputJsonValue } : {}),
      ...(newsShadow ? { newsShadow } : {}),
    });
  }

  /** The observe-mode shadow (see {@link judgeAndRecord}); null when off or on failure. */
  private newsShadowFor(entry: RosterEntry, packetTick: TickSnapshot, now: Date): Prisma.InputJsonValue | null {
    try {
      return this.packets.shadowNewsEvents?.(entry, packetTick, now) ?? null;
    } catch (err) {
      this.logger.warn(`[news-shadow] ${entry.symbol}: shadow blocks failed, verdict recorded without them: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A full cap is expected under a slow judge; said once a minute, not once per skipped position per tick. */
  private reportCapFull(entry: RosterEntry): void {
    const nowMs = Date.now();
    if (nowMs - this.capReportedAt < OI_CAPTURE_INTERVAL_MS) return;
    this.capReportedAt = nowMs;
    this.logger.warn(
      `${this.judging.size} sentinel judgements already in flight (cap ${JUDGE_CONCURRENCY}); ` +
        `${entry.symbol} (${entry.trackerId}) and any others wanting one wait for a later tick — ` +
        'their sensors, latch and OI capture keep running meanwhile',
    );
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

    // The one exception to "only ever false -> true": a changed cost basis.
    if (state.greenFloorEntry !== undefined && state.greenFloorEntry !== tick.entryPrice) {
      state.greenFloorArmed = false;
    }
    state.greenFloorEntry = tick.entryPrice;
    state.greenFloorArmed = state.greenFloorArmed || armedNow || storedFloorArmed(last, tick.entryPrice);
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
    state: TrackerState,
    tick: TickReading,
    now: Date,
  ): Promise<EnsuredThesis> {
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
        carriedFires: [],
        wantedSince: null,
        noiseFloor: { armed: false, level: null, entry: null },
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
  private prune(owners: Set<string>, live: Set<string>, watched: Set<string>): void {
    for (const [trackerId, state] of this.state) {
      if (owners.has(state.userId) && !live.has(trackerId)) {
        this.state.delete(trackerId);
        this.warnedMissingUnderlying.delete(trackerId);
      }
    }
    for (const u of owners) this.sensorBook?.prune(u, watched);
    for (const u of owners) this.newsWatch?.prune(u, watched);
  }

  /**
   * News & events v2 sensor inputs (R4/R5). `true`: the unseen fresh own-instrument ids
   * (empty inside the news cooldown, so a busy tape cannot fire every pass) and the
   * nearest un-fired timed high-impact event ≤ EVENT_WAKE_LEAD_MIN. `observe`: no input
   * keys — the would-be event fire is logged once instead. `false`: {}.
   */
  private newsInputs(entry: RosterEntry, tick: TickReading, st: TrackerState, now: Date): Pick<TripwireInput, 'newsUnseen' | 'eventNear'> {
    const cfg = this.newsCfg;
    if (!cfg?.computing) return {};
    const out: Pick<TripwireInput, 'newsUnseen' | 'eventNear'> = {};
    // Edge-trigger news-hit whenever v2 computes, not only when it renders: in `observe`
    // the legacy sensor re-fired every pass while any headline was < 30 min old (prod
    // 2026-10-19: 45 judge calls in 25 min on one position, which the futile-rejudge rule
    // must let through because news-hit is a new-risk fire). New headlines still fire at once.
    if (tick.freshNews) {
      const seen = (st.newsSeen ??= new Set<string>());
      const live = new Set(tick.freshNews.map((f) => f.id));
      for (const id of [...seen]) if (!live.has(id)) seen.delete(id);
      const cooling = now.getTime() - (st.lastNewsFireAt ?? -Infinity) < cfg.wakeCooldownMin * 60_000;
      out.newsUnseen = cooling ? [] : tick.freshNews.filter((f) => !seen.has(f.id));
    }
    const near = this.nearEvent(entry, tick, st, now, cfg.eventWakeLeadMin);
    if (cfg.rendering) out.eventNear = near;
    else if (near) {
      (st.eventsFired ??= new Set<string>()).add(near.id);
      this.logger.log(`[news-wake] observe: would fire event-near on ${entry.symbol}: ${near.title} in ${near.minutesAway} min`);
    }
    return out;
  }

  /** The nearest timed high-impact event ≤ `leadMin` away not yet fired for this tracker; a synchronous peek, never throws. */
  private nearEvent(
    entry: RosterEntry,
    tick: TickReading,
    st: TrackerState,
    now: Date,
    leadMin: number,
  ): { id: string; title: string; minutesAway: number } | null {
    const fired = (st.eventsFired ??= new Set<string>());
    if (!this.events || !tick.structureSymbol) return null;
    const p = newsPositionOf(tick.structureSymbol, entry.exchange, tick.expiry);
    if ('unresolved' in p) return null;
    let peek;
    try {
      peek = this.events.peek(p, now);
    } catch {
      return null;
    }
    if (peek.status !== 'ok') return null;
    const live = new Set(peek.events.map((e) => e.id));
    for (const id of [...fired]) if (!live.has(id)) fired.delete(id);
    const e = peek.events.find((x) => x.impact === 'high' && !x.allDay && x.minutesAway <= leadMin && !fired.has(x.id));
    return e ? { id: e.id, title: e.title, minutesAway: e.minutesAway } : null;
  }

  /** After the sensors: remember what news-hit / event-near fired on, so neither fires twice (R4). */
  private markNewsFired(st: TrackerState, fires: TripwireFire[], newsIn: Pick<TripwireInput, 'newsUnseen' | 'eventNear'>, now: Date): void {
    if (newsIn.newsUnseen?.length && fires.some((f) => f.name === 'news-hit')) {
      const seen = (st.newsSeen ??= new Set<string>());
      for (const f of newsIn.newsUnseen) seen.add(f.id);
      st.lastNewsFireAt = now.getTime();
    }
    if (newsIn.eventNear && fires.some((f) => f.name === 'event-near')) (st.eventsFired ??= new Set<string>()).add(newsIn.eventNear.id);
  }
}

/** The verdict-row fields the judge gate reads (a structural subset of the Prisma row). */
type SentinelVerdictLike = {
  verdict: string;
  createdAt: Date;
  reviewInSec?: number | null;
  netPnl?: number | null;
  triggeredBy?: unknown;
  packet?: unknown;
  exitTrigger?: unknown;
};

/** How one detached judgement ended, as the report bucket it lands in. */
type JudgeOutcome = 'evaluated' | 'failed';

/** `a` plus whichever of `b` it does not already name, first occurrence kept. */
function mergeFires(a: TripwireFire[], b: TripwireFire[]): TripwireFire[] {
  if (b.length === 0) return a;
  const seen = new Set(a.map((f) => f.name));
  return [...a, ...b.filter((f) => !seen.has(f.name) && (seen.add(f.name), true))];
}

/**
 * Fold fires carried from earlier ticks (see `TrackerState.carriedFires`) into
 * this tick's decision. A carried fire is a fire the agent has not yet seen, so
 * it wakes the agent at the FIRE tier exactly as a fresh one would.
 */
export function withCarriedFires(decision: TripwireResult, carried: TripwireFire[]): TripwireResult {
  if (carried.length === 0) return decision;
  return { ...decision, fires: mergeFires(decision.fires, carried), shouldEvaluate: true, trigger: 'FIRE' };
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
