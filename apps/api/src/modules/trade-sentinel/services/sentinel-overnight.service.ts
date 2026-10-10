import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RosterService, type RosterEntry } from './roster.service';
import { ContextPacketService, absent, packetAsJson, present, type Block } from './context-packet.service';
import { SentinelAgentService } from './sentinel-agent.service';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import { SentinelThesisRepository } from '../repositories/sentinel-thesis.repository';
import {
  SentinelCycleService,
  SharedJobExpired,
  TICK_SOURCE,
  agentBackoffMs,
  storedFloorArmed,
  type TickReading,
  type TickSource,
} from './sentinel-cycle.service';
import { SENTINEL_ENABLED_KEY } from './sentinel-runner.service';
import { isAnyExchangeOpen } from '../market-sessions';
import {
  AFTER_CLOSE_EQUITY,
  AFTER_CLOSE_MCX,
  OVERNIGHT_CRON_EQUITY,
  OVERNIGHT_CRON_MCX,
  OVERNIGHT_CRON_MCX_LATE,
  PRE_OPEN,
  PRE_OPEN_CRON,
  makeSentinelClock,
  reviewWindowIsClosed,
  daysToExpiry,
  lastSessionClose,
  nextSessionOpen,
  selectForWindow,
  windowTag,
  type ReviewWindow,
} from '../overnight/overnight-calendar';
import {
  cueBlock,
  newsSinceCloseBlock,
  oiAnalysisBlock,
  overnightDecayBlock,
  parseOptionSymbol,
  preOpenPriceBlock,
  type NewsEvidence,
} from '../overnight/overnight-evidence';
import type { OvernightGreeks, OvernightPacket, OvernightSection } from '../overnight/overnight-packet.types';
import type { SessionClock } from '../../market-hub/session-clock';
import {
  OVERNIGHT_EVIDENCE,
  type OvernightEvidenceQuery,
  type OvernightEvidenceSource,
  type RawCue,
  type RawCues,
  type RawOiEvidence,
} from '../ports/overnight-evidence.port';

/**
 * How many failed judgements one position may cost one window before it is
 * left for the night. The window's crons fire three times; a fourth try would
 * have nowhere to come from anyway, but the limit is stated rather than implied
 * so a cron change cannot quietly multiply the spend of a broken judge.
 */
export const OVERNIGHT_FAILURE_LIMIT = 3;

/** A source call's outcome: its value, or the error it threw. */
export type Sourced<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SectionInputs {
  entry: RosterEntry;
  tick: TickReading;
  window: ReviewWindow;
  tag: string;
  now: Date;
  news: Sourced<NewsEvidence>;
  oi: Sourced<RawOiEvidence>;
  cues: Sourced<RawCues>;
  /** The venue clock (holidays + MCX late close). Defaults to the shipped calendar. */
  clock?: SessionClock;
}

export interface WindowReport {
  window: string;
  disabled?: true;
  picked: number;
  judged: number;
  alreadyDone: number;
  failed: number;
  /** In backoff after a failure, or past the failure limit for this window. */
  deferred: number;
  /** Still queued for a judge slot when the venue opened — dropped, never judged against a live market. */
  droppedAtOpen: number;
}

/**
 * The `reason` column of an overnight row: the risk and the open plan, as two
 * labelled lines. The `sentinel_verdicts` table has no column for an open plan,
 * and adding one would need a migration and a regenerated client for what is,
 * to every reader, prose — so it is stored as readable text that the chart
 * splits back apart (`apps/web/.../overnightPlanView.ts`).
 */
export function formatOvernightReason(overnightRisk: string, openPlan: string): string {
  // Each section on ONE line: a model's multi-line plan would otherwise be cut at
  // its first newline by anything reading the row line by line.
  const oneLine = (t: string) => String(t ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return `OVERNIGHT RISK: ${oneLine(overnightRisk)}\nOPEN PLAN: ${oneLine(openPlan)}`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * What `lastPriceAt` means. Overnight the hub's ≤10 s price is never fresh, so
 * the closed-session tick is the tracker row's price, and the only time it has
 * is the row's `updatedAt` — the last write to the row, which can be later than
 * the exchange print. Said so, rather than passed off as a print time.
 */
export const LAST_PRICE_AT_BASIS = 'as of tracker update (the position row’s last write, not the exchange print time)';

/**
 * The overnight section of the packet, from what the sources returned. Pure.
 *
 * Every source failure becomes a stated absence that NAMES the source and the
 * error — the judge is told it cannot see, not handed a quiet hole.
 */
export function assembleOvernightSection(input: SectionInputs): OvernightSection {
  const { entry, tick, window, tag, now } = input;
  const clock = input.clock;
  const exchange = entry.exchange;
  const lastClose = lastSessionClose(exchange, now, clock);
  const nextOpen = nextSessionOpen(exchange, now, clock);
  const option = tick.segment === 'OPT' ? parseOptionSymbol(entry.symbol) : null;

  const exp = daysToExpiry(tick.expiry, exchange, now, clock);
  const expiry: OvernightSection['expiry'] =
    exp && tick.expiry
      ? present({ expiry: tick.expiry, ...exp }, 'derived from the contract expiry and the exchange holiday calendar', now.toISOString())
      : absent('the contract expiry could not be resolved — days to expiry unknown (not zero)');

  const oiEvidence = input.oi.ok ? input.oi.value : null;
  const leg = oiEvidence?.legGreeks ?? null;

  const decay = overnightDecayBlock({
    segment: tick.segment,
    side: tick.side,
    qty: tick.qty,
    premium: tick.ltp,
    spot: tick.underlyingLtp,
    strike: option?.strike ?? null,
    optionType: option?.optionType ?? null,
    expiry: tick.expiry,
    now,
    nextOpen,
    chainTheta: leg?.theta ?? null,
  });

  let greeks: Block<OvernightGreeks>;
  if (tick.segment === 'FUT') {
    greeks = absent('this is a future — no option greeks (its delta is 1 per unit by construction)');
  } else if (leg) {
    greeks = present({ delta: leg.delta, gamma: leg.gamma, theta: leg.theta, vega: leg.vega, iv: leg.iv }, leg.source, leg.at);
  } else {
    greeks = absent(
      input.oi.ok
        ? 'no greeks for this strike — the options chain had no leg for it'
        : `no greeks — options-chain.service failed: ${input.oi.error}`,
    );
  }

  const preOpenPrice =
    window.kind === 'PRE_OPEN_REVIEW'
      ? preOpenPriceBlock(exchange, now, { price: tick.ltp, at: tick.ltpAt ?? null })
      : absent(
          'after-close review — the next session’s pre-open has not happened yet, so no pre-open or ' +
            'indicative price exists. position.ltp is this session’s last price.',
        );

  const since = lastClose ?? new Date(now.getTime() - 24 * HOUR_MS);
  const news = input.news.ok
    ? newsSinceCloseBlock(input.news.value, since, now)
    : absent(`news-aggregator.service failed: ${input.news.error} — news since the close is UNSEEN, not quiet`);

  const oi = input.oi.ok ? oiAnalysisBlock(input.oi.value.analysis) : absent(`options-chain.service failed: ${input.oi.error}`);

  const cue = (raw: RawCue) =>
    raw.reading ? cueBlock(raw.reading, raw.source, now) : cueBlock(null, '', now, raw.reason);
  let marketCues: OvernightSection['marketCues'];
  if (input.cues.ok) {
    const c = input.cues.value;
    marketCues = {
      nasdaq: cue(c.nasdaq),
      crudeOil: cue(c.crudeOil),
      gold: cue(c.gold),
      fiiFlows: cue(c.fiiFlows),
      indiaVix: cue(c.indiaVix),
      sectorStrength:
        c.sectorStrength.value !== null
          ? present(c.sectorStrength.value, c.sectorStrength.source, c.sectorStrength.at)
          : absent(c.sectorStrength.reason),
      underlyingChange: cue(c.underlyingChange),
    };
  } else {
    const failed = absent(`market-cue sources failed: ${input.cues.error}`);
    marketCues = {
      nasdaq: failed,
      crudeOil: failed,
      gold: failed,
      fiiFlows: failed,
      indiaVix: failed,
      sectorStrength: failed,
      underlyingChange: failed,
    };
  }

  return {
    review: {
      kind: window.kind,
      window: tag,
      lastCloseAt: lastClose ? lastClose.toISOString() : null,
      nextOpenAt: nextOpen ? nextOpen.toISOString() : null,
      hoursUntilOpen: nextOpen ? Math.round(((nextOpen.getTime() - now.getTime()) / HOUR_MS) * 100) / 100 : null,
      lastPriceAt: tick.ltpAt ?? null,
      lastPriceAtBasis: LAST_PRICE_AT_BASIS,
    },
    expiry,
    decay,
    greeks,
    preOpenPrice,
    news,
    oi,
    marketCues,
  };
}

/**
 * THE OVERNIGHT REVIEW — after-close and pre-open judgements of every open F&O
 * position, on the overnight verdict set (`HOLD_OVERNIGHT | EXIT_AT_OPEN |
 * TIGHTEN_AT_OPEN`), each with an open plan.
 *
 * SHADOW ONLY, STRUCTURALLY. Like the cycle, nothing reachable by following this
 * file's imports can place an order: the evidence comes through a port, the
 * judge is a pure function of the packet, and the only write is a verdict row.
 * `sentinel-cycle.service.spec.ts` walks this file as an entry point.
 *
 * THE SAME CAP AS THE LIVE JUDGES. Every judgement runs inside
 * `SentinelCycleService.runShared`, so the overnight calls share
 * `JUDGE_CONCURRENCY` and the one-in-flight-per-position rule with the live
 * ones, and queue for a slot rather than racing them.
 *
 * ONCE PER POSITION PER WINDOW, durably: the window tag is written into the
 * row's `triggeredBy` and checked before judging (a restart finds it), and an
 * in-process claim stops two overlapping fires from judging the same position
 * twice. About two calls per position per day.
 */
@Injectable()
export class SentinelOvernightService {
  private readonly logger = new Logger(SentinelOvernightService.name);

  /** Per window tag: positions claimed (in flight or done) in this process. */
  private readonly claimed = new Map<string, Set<string>>();

  /** Per `trackerId|tag`: consecutive failures and when a retry is allowed. */
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  /** Holidays plus the MCX late-close season (`hub.mcxLateClose`, the hub's own setting). */
  private readonly clock: SessionClock;

  /**
   * The instant a queued job checks its venue against. Unset: the window's own
   * `now` advanced by the wall-clock time spent waiting (so a replayed or tested
   * window keeps its own clock). Settable in tests.
   */
  clockNow?: () => Date;

  constructor(
    private readonly roster: RosterService,
    private readonly packets: ContextPacketService,
    private readonly theses: SentinelThesisRepository,
    private readonly agent: SentinelAgentService,
    private readonly verdicts: SentinelVerdictRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(TICK_SOURCE) private readonly ticks: TickSource,
    @Inject(OVERNIGHT_EVIDENCE) private readonly evidence: OvernightEvidenceSource,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.clock = makeSentinelClock(this.config.get<string>('hub.mcxLateClose'));
  }

  private get enabled(): boolean {
    return this.config.get<string>(SENTINEL_ENABLED_KEY) === 'true';
  }

  @Cron(OVERNIGHT_CRON_EQUITY, { timeZone: 'Asia/Kolkata' })
  async afterCloseEquity(): Promise<void> {
    await this.fire(AFTER_CLOSE_EQUITY);
  }

  @Cron(OVERNIGHT_CRON_MCX, { timeZone: 'Asia/Kolkata' })
  async afterCloseMcx(): Promise<void> {
    await this.fire(AFTER_CLOSE_MCX);
  }

  /** After midnight, for the late-close season; gated like every other fire. */
  @Cron(OVERNIGHT_CRON_MCX_LATE, { timeZone: 'Asia/Kolkata' })
  async afterCloseMcxLate(): Promise<void> {
    await this.fire(AFTER_CLOSE_MCX);
  }

  @Cron(PRE_OPEN_CRON, { timeZone: 'Asia/Kolkata' })
  async preOpen(): Promise<void> {
    await this.fire(PRE_OPEN);
  }

  /** A scheduled fire never throws into the scheduler. */
  private async fire(window: ReviewWindow): Promise<void> {
    try {
      const report = await this.runWindow(window);
      if (report.picked > 0) {
        this.logger.log(
          `overnight review ${report.window}: ${report.judged} judged, ${report.alreadyDone} already done, ` +
            `${report.failed} failed, ${report.deferred} deferred, ${report.droppedAtOpen} dropped at the open (of ${report.picked})`,
        );
      }
    } catch (err) {
      this.logger.error(`overnight review ${window.kind}/${window.venue} aborted: ${describe(err)}`);
    }
  }

  async runWindow(window: ReviewWindow, now: Date = new Date()): Promise<WindowReport> {
    const tag = windowTag(window, now, this.clock);
    const report: WindowReport = {
      window: tag,
      picked: 0,
      judged: 0,
      alreadyDone: 0,
      failed: 0,
      deferred: 0,
      droppedAtOpen: 0,
    };
    if (!this.enabled) return { ...report, disabled: true };

    // Clock-only gate before any query: unless the venue clock says this window
    // applies to at least one venue it covers (session closed, the right side of
    // it, not a holiday or weekend), there is nothing to ask the database about.
    const venues = window.venue === 'MCX' ? ['MCX'] : window.venue === 'EQUITY' ? ['NSE', 'BSE'] : ['NSE', 'BSE', 'MCX'];
    if (!venues.some((v) => reviewWindowIsClosed(window, v, now, this.clock))) return report;

    this.pruneClaims(window, tag);
    const claims = this.claimed.get(tag) ?? new Set<string>();
    this.claimed.set(tag, claims);

    const book = await this.openTradeVenues();
    const users = [...new Set(book.map((r) => r.userId))];
    // Live judging happens only while a venue someone holds is trading — the same
    // rule (and helper) the runner's tick uses. Outside that, the live slot is
    // not reserved and overnight reviews may use every slot.
    const heldVenues = [...new Set(book.map((r) => r.exchange))];
    const jobs: Array<Promise<void>> = [];
    for (const userId of users) {
      let entries: RosterEntry[];
      try {
        entries = await this.roster.build(userId);
      } catch (err) {
        this.logger.error(`overnight review: roster failed for user ${userId}: ${describe(err)}`);
        continue;
      }
      for (const entry of selectForWindow(entries, window, now, this.clock)) {
        report.picked += 1;
        if (claims.has(entry.trackerId)) {
          report.alreadyDone += 1;
          continue;
        }
        const failKey = `${entry.trackerId}|${tag}`;
        const failure = this.failures.get(failKey);
        if (failure && (failure.count >= OVERNIGHT_FAILURE_LIMIT || now.getTime() < failure.retryAt)) {
          report.deferred += 1;
          continue;
        }
        // Claimed BEFORE the durable check, synchronously, so an overlapping
        // fire in this process cannot pass the same gate in the gap.
        claims.add(entry.trackerId);
        jobs.push(this.reviewOne(entry, window, tag, now, claims, report, heldVenues));
      }
    }
    await Promise.all(jobs);
    return report;
  }

  private async reviewOne(
    entry: RosterEntry,
    window: ReviewWindow,
    tag: string,
    now: Date,
    claims: Set<string>,
    report: WindowReport,
    heldVenues: string[] = [],
  ): Promise<void> {
    const failKey = `${entry.trackerId}|${tag}`;
    try {
      if (await this.verdicts.hasWindowVerdict(entry.trackerId, tag)) {
        report.alreadyDone += 1;
        return;
      }
    } catch (err) {
      // Cannot tell whether it was already judged: do not risk a second paid
      // call, and do not keep the claim — a later fire asks again.
      claims.delete(entry.trackerId);
      report.failed += 1;
      this.logger.error(`overnight review: could not check ${entry.symbol} for ${tag}: ${describe(err)}`);
      return;
    }

    const startedWall = Date.now();
    const current = () => (this.clockNow ? this.clockNow() : new Date(now.getTime() + (Date.now() - startedWall)));
    try {
      await this.cycle.runShared(entry.trackerId, () => this.judgeAndRecord(entry, window, tag, now), {
        // Re-checked every time the job is woken: once the venue opens (or the
        // window otherwise stops applying) a queued job is dropped, never run.
        expired: () => !reviewWindowIsClosed(window, entry.exchange, current(), this.clock),
        reserveLive: () => isAnyExchangeOpen(heldVenues, current()),
      });
      this.failures.delete(failKey);
      report.judged += 1;
    } catch (err) {
      if (err instanceof SharedJobExpired) {
        // Skipped, deliberately: the claim is kept so no later fire retries it.
        report.droppedAtOpen += 1;
        this.logger.warn(
          `overnight review for ${entry.symbol} (${entry.trackerId}) dropped: still queued when ${entry.exchange} opened (${tag})`,
        );
        return;
      }
      claims.delete(entry.trackerId);
      report.failed += 1;
      const prior = this.failures.get(failKey)?.count ?? 0;
      const count = prior + 1;
      const wait = agentBackoffMs(count);
      // FROM THE FAILURE, NOT THE DISPATCH — same rule as the live judges: a
      // queued or slow call must not have its backoff already spent on arrival.
      const tookMs = Math.max(0, Math.floor((Date.now() - startedWall) / 1000) * 1000);
      this.failures.set(failKey, { count, retryAt: now.getTime() + tookMs + wait });
      this.logger.warn(
        `overnight review failed for ${entry.symbol} (${entry.trackerId}) in ${tag}, ${count} of ` +
          `${OVERNIGHT_FAILURE_LIMIT}: ${describe(err)}`,
      );
    }
  }

  private async judgeAndRecord(entry: RosterEntry, window: ReviewWindow, tag: string, now: Date): Promise<void> {
    const tick = await this.ticks.tickFor(entry.trackerId, { closedSession: true });
    const [thesis, last] = await Promise.all([
      this.theses.find(entry.trackerId),
      this.verdicts.recentForTracker(entry.trackerId, 1).then((rows) => rows[0]),
    ]);

    const fire = {
      name: window.kind,
      detail:
        window.kind === 'PRE_OPEN_REVIEW'
          ? 'scheduled pre-open review (08:30 IST)'
          : `scheduled after-close review (${window.venue === 'MCX' ? '23:45' : '15:45'} IST)`,
    };
    const base = await this.packets.build(
      entry,
      {
        ...tick,
        oiWallNow: null,
        oiWallPrev: null,
        oiWallsAt: null,
        greenFloorArmedLatched: storedFloorArmed(last),
      },
      thesis,
      [fire],
    );

    const q: OvernightEvidenceQuery = {
      userId: entry.userId,
      symbol: entry.symbol,
      exchange: entry.exchange,
      segment: tick.segment,
      underlying: tick.structureSymbol,
      expiry: tick.expiry,
      option: tick.segment === 'OPT' ? parseOptionSymbol(entry.symbol) : null,
      underlyingLtp: tick.underlyingLtp,
      since: lastSessionClose(entry.exchange, now, this.clock) ?? new Date(now.getTime() - 24 * HOUR_MS),
      now,
    };
    const [news, oi, cues] = await Promise.all([
      sourced(() => this.evidence.news(q)),
      sourced(() => this.evidence.oi(q)),
      sourced(() => this.evidence.cues(q)),
    ]);

    const packet: OvernightPacket = {
      ...base,
      flow: {
        ...base.flow,
        // The live wall capture does not run overnight; the end-of-day walls are
        // in overnight.oi. Without this the packet would claim "no options chain".
        oiWalls: absent('not captured for the overnight review — see overnight.oi.walls for the end-of-day walls'),
      },
      overnight: assembleOvernightSection({ entry, tick, window, tag, now, news, oi, cues, clock: this.clock }),
    };

    const verdict = await this.agent.judgeOvernight(packet);
    const nextOpen = nextSessionOpen(entry.exchange, now, this.clock);
    await this.verdicts.record({
      userId: entry.userId,
      trackerId: entry.trackerId,
      symbol: entry.symbol,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      thesisStatus: verdict.thesisStatus,
      recoveryAvailable: verdict.thesisStatus !== 'BROKEN',
      reason: formatOvernightReason(verdict.overnightRisk, verdict.openPlan),
      evidence: verdict.evidence,
      invalidationPoint: verdict.changeMindLevel,
      reviewInSec: nextOpen ? Math.max(60, Math.round((nextOpen.getTime() - now.getTime()) / 1000)) : 24 * 3600,
      packet: packetAsJson(packet),
      promptVersion: this.agent.overnightPromptVersion,
      triggeredBy: [window.kind, tag],
      netPnl: packet.money.netPnl,
      greenFloor: packet.money.greenFloorPrice,
    });
  }

  /** Every (user, exchange) with an open trade; the roster then decides what is reviewable. */
  private async openTradeVenues(): Promise<Array<{ userId: string; exchange: string }>> {
    return this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { userId: true, exchange: true },
      distinct: ['userId', 'exchange'],
    });
  }

  /** Drop claims and failure counts from earlier days of this same window. */
  private pruneClaims(window: ReviewWindow, tag: string): void {
    const prefix = `window:${window.kind}:${window.venue}:`;
    for (const key of [...this.claimed.keys()]) {
      if (key.startsWith(prefix) && key !== tag) this.claimed.delete(key);
    }
    for (const key of [...this.failures.keys()]) {
      const keyTag = key.slice(key.indexOf('|') + 1);
      if (keyTag.startsWith(prefix) && keyTag !== tag) this.failures.delete(key);
    }
  }
}

async function sourced<T>(fn: () => Promise<T>): Promise<Sourced<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
