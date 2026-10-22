// apps/api/src/modules/mbm/services/oi-history-backfill.service.ts
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { runInBootLane } from '../../../common/utils/boot-lane';
import { AngelThrottleError, HISTORICAL_THROTTLE_RETRY_DELAYS_MS } from '../../market-data/services/angel-throttle';
import type { OiPoint } from '../../market-data/services/oi-data.util';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import type { NseCalendar } from '../domain/bar-window';
import {
  CHUNK_CANDIDATES_DAYS,
  DAY_MS,
  EMPTY_STREAK_STOP,
  PROBE_INTERVALS,
  inBlackout,
  istDays,
  istYmd,
  lastCompletedSession,
  selectContracts,
  sessionsIn,
  windowCovered,
  type OiContract,
  type OiHistoryConfig,
} from '../domain/oi-history';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';
import { OiHistoryRepository, type OiProgress } from '../repositories/oi-history.repository';
import { MBM_CALENDAR, MBM_NOW } from './mbm-bar-refresher.service';

export const OI_HISTORY_CONFIG = Symbol('OI_HISTORY_CONFIG');
/** Test seam for the throttle back-off. */
export const OI_HISTORY_SLEEP = Symbol('OI_HISTORY_SLEEP');

const UNDERLYING = 'NIFTY';
const LEASE_TTL_MS = 90 * 60_000;
/** This many contracts failing in a row (non-throttle broker errors) ends the run with stopped=error. */
export const MAX_ERRORS_IN_A_ROW = 10;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type StopReason =
  | 'complete'
  | 'budget'
  | 'market-hours'
  | 'throttled'
  | 'no-futures'
  | 'no-interval'
  | 'no-spot'
  | 'error';

export interface BackfillSummary {
  ran: boolean;
  /** Why the run did not start (ran=false) or why it ended. */
  stopped?: StopReason | 'disabled' | 'busy' | 'lease' | 'nothing-to-do';
  line?: string;
  calls: number;
  rows: number;
}

/** The broker said slow down even after the retries: the run ends (resumes next run). */
class ThrottledOut extends Error {}
/** The budget or the market-hours guard ended the run before a call. */
class StopRun extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

interface RunState {
  calls: number;
  rows: number;
  empty: number;
  throttled: number;
  errors: number;
  /** Backward windows Angel refused with AB1012 (= before the contract's history), counted as empty. */
  badRequestEnd: number;
  /** Consecutive contract-level broker errors. */
  errorRun: number;
  lastError?: string;
}

/**
 * Backfills nifty_oi_history with Angel's PAST intraday open interest (getOIData) for LIVE NIFTY
 * contracts — every unexpired future + option expiries up to OI_BACKFILL_EXPIRY_DAYS ahead, strikes
 * ±OI_BACKFILL_STRIKES around the NIFTY spot range over OI_BACKFILL_SPOT_DAYS — so OI research need not wait for
 * months of our own 5-min capture. Angel serves nothing for expired contracts, so this is the only window.
 *
 * Uses ONLY the owner's existing Angel session through UserFeedManager (MBM_FEED_USER_ID, like the bar
 * refresher and the chain capture): it never logs in, and every call rides the session's 350 ms
 * historical pacing. Per run: probe the intervals (finest that returns rows wins) and the widest request
 * window Angel answers in full, fetch the NIFTY daily range, select contracts, then per contract
 * forward-fill from its covered edge to now and walk back from its cursor until 2 empty windows in a row or
 * the lookback floor. Progress is saved after every call (resumable, idempotent inserts).
 *
 * Runs at 01:30 IST nightly and once at boot when unfinished; never 08:30–15:45 IST on NSE trading days
 * (checked before every call), at most OI_BACKFILL_MAX_CALLS calls per run, one instance via the cron
 * lease. ONE summary line per run. Never throws.
 */
@Injectable()
export class OiHistoryBackfillService implements OnModuleInit {
  private readonly logger = new Logger(OiHistoryBackfillService.name);
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;

  constructor(
    @Inject(OI_HISTORY_CONFIG) private readonly cfg: OiHistoryConfig,
    @Inject(MBM_CONFIG) private readonly mbm: MbmConfig,
    @Inject(MBM_CALENDAR) private readonly calendar: NseCalendar,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly repo: OiHistoryRepository,
    @Optional() private readonly lease?: CronLeaseService,
    @Optional() @Inject(OI_HISTORY_SLEEP) sleep?: (ms: number) => Promise<void>,
  ) {
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get user(): string | null {
    return this.cfg.enabled ? this.mbm.feedUserId : null;
  }

  onModuleInit(): void {
    if (!this.user) return;
    if (!bootJobsEnabled()) return void this.logger.log(`[oi-history] ${BOOT_JOBS_DISABLED}`);
    // Last in the boot lane: the broker-heavy boot jobs that the morning needs go first.
    void runInBootLane('oi-history-backfill', 90, () => this.bootRun());
  }

  @Cron('0 30 1 * * *', { name: 'oi-history-backfill', timeZone: 'Asia/Kolkata' })
  async onNightly(): Promise<BackfillSummary> {
    return this.run('nightly');
  }

  /** Boot: run only when outside market hours and the stored contract set is unfinished or behind. */
  async bootRun(): Promise<BackfillSummary> {
    if (!this.user) return { ran: false, stopped: 'disabled', calls: 0, rows: 0 };
    const now = this.now();
    if (inBlackout(this.calendar, now)) return { ran: false, stopped: 'market-hours', calls: 0, rows: 0 };
    try {
      const p = await this.repo.pending(istYmd(now));
      const session = lastCompletedSession(this.calendar, now);
      const current = p.stalest !== null && (!session || p.stalest.getTime() >= session.to.getTime());
      if (p.total > 0 && p.pending === 0 && current) {
        this.logger.log(`[oi-history] boot: ${p.total} contracts already backfilled and current — nothing to do`);
        return { ran: false, stopped: 'nothing-to-do', calls: 0, rows: 0 };
      }
    } catch (e) {
      this.logger.warn(`[oi-history] boot: progress unreadable (${errText(e)}) — running anyway`);
    }
    return this.run('boot');
  }

  async run(trigger: string): Promise<BackfillSummary> {
    if (!this.user) return { ran: false, stopped: 'disabled', calls: 0, rows: 0 };
    if (inBlackout(this.calendar, this.now())) {
      this.logger.log(`[oi-history] trigger=${trigger} refused: NSE market hours (08:30–15:45 IST)`);
      return { ran: false, stopped: 'market-hours', calls: 0, rows: 0 };
    }
    if (this.running) return { ran: false, stopped: 'busy', calls: 0, rows: 0 };
    this.running = true;
    try {
      const job = () => this.backfill(trigger);
      const out = this.lease ? await this.lease.runExclusiveFailClosed('oi-history-backfill', LEASE_TTL_MS, job) : await job();
      return out ?? { ran: false, stopped: 'lease', calls: 0, rows: 0 };
    } catch (e) {
      this.logger.warn(`[oi-history] trigger=${trigger} failed: ${errText(e)}`);
      return { ran: false, stopped: 'error', calls: 0, rows: 0 };
    } finally {
      this.running = false;
    }
  }

  private async backfill(trigger: string): Promise<BackfillSummary> {
    const started = this.now();
    const st: RunState = { calls: 0, rows: 0, empty: 0, throttled: 0, errors: 0, errorRun: 0, badRequestEnd: 0 };
    const probe: string[] = [];
    let interval: string | null = null;
    let chunkDays = 0;
    let selection: { contracts: OiContract[]; capped: number; expiries: number } | null = null;
    let spot = '';
    let walked = 0;
    let stopped: StopReason = 'complete';
    try {
      const today = istYmd(started);
      const futures = await this.repo.futures(UNDERLYING, today);
      if (futures.length === 0) throw new StopRun('no-futures');
      const probeRef: TokenRef = { token: futures[0].token, exchange: 'NFO' };

      // 1. Interval probe on the nearest future over the last completed session. A throttle ends the
      //    run (an unknown answer must not downgrade the interval for good).
      const session = lastCompletedSession(this.calendar, started);
      if (!session) throw new StopRun('no-interval');
      const answered: string[] = [];
      for (const iv of PROBE_INTERVALS) {
        try {
          const pts = await this.oiCall(st, probeRef, iv, session.from, session.to);
          probe.push(`${iv}:${pts.length ? pts.length : 'empty'}`);
          if (pts.length > 0) answered.push(iv);
          if (pts.length > 0 && !interval) interval = iv;
        } catch (e) {
          if (e instanceof ThrottledOut || e instanceof StopRun) throw e;
          probe.push(`${iv}:err(${errText(e).slice(0, 80)})`);
        }
      }
      if (!interval) throw new StopRun('no-interval');
      const pref = this.cfg.preferredInterval;
      if (pref && answered.includes(pref)) interval = pref;

      // 2. Chunk probe: the widest window Angel answers IN FULL for the nearest future (listed ≥ ~2 months).
      chunkDays = 1;
      const end = started;
      for (const d of [...new Set(CHUNK_CANDIDATES_DAYS.map((c) => Math.min(c, this.cfg.maxChunkDays)))]) {
        if (d <= 1) break;
        const start = new Date(end.getTime() - d * DAY_MS);
        let pts: OiPoint[];
        try {
          pts = await this.oiCall(st, probeRef, interval, start, end);
        } catch (e) {
          if (e instanceof ThrottledOut || e instanceof StopRun) throw e;
          continue; // e.g. "range too wide": try the next, narrower window
        }
        const sessions = sessionsIn(this.calendar, start, end).length;
        if (windowCovered(sessions, istDays(pts))) {
          chunkDays = d;
          break;
        }
      }

      // 3. NIFTY spot range over OI_BACKFILL_SPOT_DAYS (one daily candle call) → the strike band.
      const index = INDEX_UNDERLYINGS[UNDERLYING];
      await this.guard(st);
      st.calls++;
      const days = await this.feeds.fetchCandleWindow(
        this.user as string,
        { token: index.token, exchange: index.exchange },
        'ONE_DAY',
        new Date(started.getTime() - this.cfg.spotRangeDays * DAY_MS),
        started,
      );
      const good = (days ?? []).filter((c) => c.low > 0 && c.high > 0 && c.close > 0);
      if (good.length === 0) throw new StopRun('no-spot');
      const low = Math.min(...good.map((c) => c.low));
      const high = Math.max(...good.map((c) => c.high));
      const last = good[good.length - 1].close;
      spot = `${Math.round(low)}-${Math.round(high)}@${Math.round(last)}`;

      // 4. Contracts.
      const horizon = istYmd(new Date(started.getTime() + this.cfg.expiryHorizonDays * DAY_MS));
      const expiries = (await this.repo.optionExpiries(UNDERLYING, today)).filter((e) => e <= horizon);
      const options = new Map<string, OiContract[]>();
      for (const e of expiries) options.set(e, await this.repo.options(UNDERLYING, e));
      const sel = selectContracts({ futures, options, low, high, last, strikesAround: this.cfg.strikesAround, maxContracts: this.cfg.maxContracts });
      selection = { ...sel, expiries: expiries.length };

      // 5. Walk each contract: forward to now, then back.
      const progress = await this.repo.progress(interval, sel.contracts.map((c) => c.token));
      for (const c of sel.contracts) {
        await this.walk(st, c, interval, chunkDays, progress.get(c.token) ?? null, started);
        walked++;
      }
    } catch (e) {
      if (e instanceof StopRun) stopped = e.reason;
      else if (e instanceof ThrottledOut) stopped = 'throttled';
      else {
        stopped = 'error';
        st.errors++;
        st.lastError = errText(e);
      }
    }

    const line = await this.summaryLine(trigger, started, st, { probe, interval, chunkDays, selection, spot, walked, stopped });
    if (stopped === 'complete' || stopped === 'budget' || stopped === 'market-hours') this.logger.log(line);
    else this.logger.warn(line);
    return { ran: true, stopped, line, calls: st.calls, rows: st.rows };
  }

  /**
   * One contract: forward from its covered edge to `now`, then backward from its cursor in `chunkDays`
   * windows until EMPTY_STREAK_STOP empty windows in a row or the lookback floor. Windows without an NSE
   * session cost no call. Progress saved after every call. A broker error on this contract is counted and
   * the walk moves to the next contract; throttle / budget / market hours end the run.
   */
  private async walk(st: RunState, c: OiContract, interval: string, chunkDays: number, prev: OiProgress | null, now: Date): Promise<void> {
    const p: OiProgress = prev
      ? { ...prev }
      : { cursor: now, coveredTo: now, emptyStreak: 0, done: false, earliestTs: null, latestTs: null, rows: 0, calls: 0 };
    if (!p.cursor) p.cursor = p.coveredTo ?? now;
    if (!p.coveredTo) p.coveredTo = p.cursor;
    const ref: TokenRef = { token: c.token, exchange: 'NFO' };
    const chunkMs = chunkDays * DAY_MS;
    const floor = new Date(now.getTime() - this.cfg.lookbackDays * DAY_MS);
    let dirty = !prev;

    const take = (pts: OiPoint[], added: number) => {
      p.rows += added;
      for (const x of pts) {
        if (!p.earliestTs || x.ts < p.earliestTs) p.earliestTs = x.ts;
        if (!p.latestTs || x.ts > p.latestTs) p.latestTs = x.ts;
      }
    };
    const fetch = async (from: Date, to: Date, backward = false): Promise<OiPoint[] | null> => {
      try {
        const pts = await this.oiCall(st, ref, interval, from, to);
        p.calls++;
        const added = await this.repo.insert(c, interval, pts);
        st.rows += added;
        st.errorRun = 0;
        take(pts, added);
        return pts;
      } catch (e) {
        if (e instanceof ThrottledOut || e instanceof StopRun) throw e;
        // Prod 2026-10-23: walking back past a contract's history Angel answers AB1012 "Invalid Bad
        // Request" (875 of 883 contracts) instead of an empty list. Going back, that is the end of the
        // history: count it as an empty window so the 2-empty rule finishes the contract.
        if (backward && /AB1012/.test(errText(e))) {
          p.calls++;
          st.badRequestEnd++;
          return [];
        }
        st.errors++;
        st.lastError = `${c.symbol}: ${errText(e).slice(0, 160)}`;
        // A session that cannot answer at all must not burn the whole budget one contract at a time.
        if (++st.errorRun >= MAX_ERRORS_IN_A_ROW) throw new StopRun('error');
        return null;
      }
    };

    try {
      // Forward: (coveredTo, now].
      while ((p.coveredTo as Date).getTime() < now.getTime()) {
        const from = p.coveredTo as Date;
        const to = new Date(Math.min(from.getTime() + chunkMs, now.getTime()));
        if (sessionsIn(this.calendar, from, to).length > 0) {
          const pts = await fetch(from, to);
          if (pts === null) return;
        }
        p.coveredTo = to;
        dirty = true;
        await this.repo.saveProgress(c, interval, p);
        dirty = false;
      }
      // Backward: [floor, cursor).
      while (!p.done) {
        const cursor = p.cursor as Date;
        if (cursor.getTime() <= floor.getTime()) {
          p.done = true;
          await this.repo.saveProgress(c, interval, p);
          break;
        }
        const from = new Date(Math.max(cursor.getTime() - chunkMs, floor.getTime()));
        if (sessionsIn(this.calendar, from, cursor).length > 0) {
          const pts = await fetch(from, cursor, true);
          if (pts === null) return;
          if (pts.length === 0) {
            p.emptyStreak++;
            st.empty++;
          } else p.emptyStreak = 0;
        }
        p.cursor = from;
        if (p.emptyStreak >= EMPTY_STREAK_STOP) p.done = true;
        dirty = true;
        await this.repo.saveProgress(c, interval, p);
        dirty = false;
      }
    } finally {
      if (dirty) await this.repo.saveProgress(c, interval, p).catch(() => undefined);
    }
  }

  /** Budget + market-hours check before every broker call. */
  private async guard(st: RunState): Promise<void> {
    if (st.calls >= this.cfg.maxCalls) throw new StopRun('budget');
    if (inBlackout(this.calendar, this.now())) throw new StopRun('market-hours');
  }

  /** One getOIData window with the throttle retries (1 s, 2 s); every attempt is a counted call. */
  private async oiCall(st: RunState, ref: TokenRef, interval: string, from: Date, to: Date): Promise<OiPoint[]> {
    for (let attempt = 0; ; attempt++) {
      await this.guard(st);
      st.calls++;
      try {
        return (await this.feeds.fetchOIWindow(this.user as string, ref, interval, from, to)) ?? [];
      } catch (e) {
        if (!(e instanceof AngelThrottleError)) throw e;
        st.throttled++;
        if (attempt >= HISTORICAL_THROTTLE_RETRY_DELAYS_MS.length) throw new ThrottledOut(errText(e));
        await this.sleep(HISTORICAL_THROTTLE_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  private async summaryLine(
    trigger: string,
    started: Date,
    st: RunState,
    r: {
      probe: string[];
      interval: string | null;
      chunkDays: number;
      selection: { contracts: OiContract[]; capped: number; expiries: number } | null;
      spot: string;
      walked: number;
      stopped: StopReason;
    },
  ): Promise<string> {
    const kinds = { FUT: 0, CE: 0, PE: 0 };
    for (const c of r.selection?.contracts ?? []) kinds[c.kind]++;
    let perKind = 'n/a';
    let earliest = 'none';
    let done = '';
    if (r.interval) {
      try {
        const rows = await this.repo.summary(r.interval);
        const day = (d: Date | null) => (d ? istYmd(new Date(d)) : 'none');
        perKind = rows.map((k) => `${k.kind}: ${day(k.earliest)} (${k.done}/${k.contracts} done, ${k.rows} rows)`).join(', ') || 'none';
        const all = rows.map((k) => k.earliest).filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
        if (all.length) earliest = istYmd(new Date(Math.min(...all)));
        done = ` done=${rows.reduce((a, k) => a + k.done, 0)}/${rows.reduce((a, k) => a + k.contracts, 0)}`;
      } catch (e) {
        perKind = `unavailable (${errText(e).slice(0, 80)})`;
      }
    }
    const n = r.selection?.contracts.length ?? 0;
    return (
      `[oi-history] trigger=${trigger} stopped=${r.stopped}` +
      ` contracts=${n} (FUT ${kinds.FUT}, CE ${kinds.CE}, PE ${kinds.PE}; expiries ${r.selection?.expiries ?? 0}; capped ${r.selection?.capped ?? 0}; walked ${r.walked})` +
      ` calls=${st.calls}/${this.cfg.maxCalls} rows=${st.rows} interval=${r.interval ?? 'none'} probe={${r.probe.join(', ')}}` +
      ` chunk=${r.chunkDays}d earliest=${earliest} per-kind={${perKind}}${done}` +
      ` empty=${st.empty} endAB1012=${st.badRequestEnd} throttled=${st.throttled} errors=${st.errors} spot=${r.spot || 'n/a'}` +
      ` elapsed=${Math.round((this.now().getTime() - started.getTime()) / 1000)}s` +
      (st.lastError ? ` lastError="${st.lastError}"` : '')
    );
  }
}
