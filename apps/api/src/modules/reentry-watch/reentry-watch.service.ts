import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { sendOpsAlert } from '../../common/utils/ops-alert';
import { INDEX_UNDERLYINGS } from '../market-hub/underlying';
import { segmentFor } from '../signal-trader/domain/contract-resolver';
import { decisionTag } from '../signal-trader/domain/paper';
import type { SignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';
import { SignalOiCheckService } from '../signal-trader/services/signal-oi-check.service';
import type { InstrumentMasterLike, QuotesLike, SessionClockLike } from '../signal-trader/services/signal-trader.service';
import { atmCandidates, engineContract, engineSignal, ENGINE_LIQUIDITY, optionFutureSpot, pickLiquidStrike, planEngineEntry } from '../entry-engine/domain/engine-contract';
import { chooseBars, istDayAt, readOi, sessionStartOf } from '../entry-engine/domain/engine-inputs';
import { trendReading, type Bar1m, type Direction, type OiReading, type TrendReading } from '../entry-engine/domain/entry-decision';
import { EntryEnginePaperService } from '../entry-engine/entry-engine-paper.service';
import { EntryEngineRepository } from '../entry-engine/entry-engine.repository';
import {
  alertText, bestUnderlying, decideReentry, directionOf, kindFor, moveInN, noise15, noiseSessionOf, REENTRY_UNIVERSE, underlyingAt, watchKey,
  type ExitedPosition, type NoiseUnit, type ReentryVerdict,
} from './domain/reentry-rules';
import { REENTRY_OF_TAG, REENTRY_SOURCE, REENTRY_STRATEGY, REENTRY_TAG, REENTRY_WATCH_CONFIG, type ReentryWatchConfig } from './reentry-watch.config';
import { ReentryWatchRepository, type LiveCounts } from './reentry-watch.repository';
import { EntryJudgeService, type EntryJudgeResult } from '../trade-sentinel/services/entry-judge.service';
import { istMinuteOf, liveGate, type LiveGateInput, type ReentryLiveLimit } from './domain/reentry-live-gate';
import { sizeLiveReentry, type LiveSize } from './domain/reentry-live-size';
import type { EntryPlan } from '../signal-trader/domain/gate';
import { fundsCheck, isFundsRejection, requiredFunds } from '../signal-trader/domain/funds';
import { miniFallbackOn, miniMaxLots, miniNameFor, planMini } from '../signal-trader/domain/mini-swap';
import { slEnforceability } from '../signal-trader/domain/execution';
import type { FundsLike } from '../signal-trader/services/signal-trader.service';
import { SignalExecutorService, type PlaceResult } from '../signal-trader/services/signal-executor.service';
import { isLiveTradingEnabled } from '../trade-engine/live-trading';

/** After the AI entry judge declines a re-entry, the same watch may ask again only after this long. */
export const REENTRY_JUDGE_RETRY_MS = 10 * 60_000;

export const REENTRY_CLOCK = Symbol('REENTRY_CLOCK');
/** The session clock, plus (optionally) the current instant the LIVE gate reads at decision time. */
export type ReentryClockLike = SessionClockLike & { now?: () => Date };
export const REENTRY_MASTER = Symbol('REENTRY_MASTER');
export const REENTRY_QUOTES = Symbol('REENTRY_QUOTES');
export const REENTRY_SIGNAL_CONFIG = Symbol('REENTRY_SIGNAL_CONFIG');
/** The owner alert (sendOpsAlert); a token so tests can watch it. */
export const REENTRY_ALERT = Symbol('REENTRY_ALERT');
export type AlertFn = (key: string, text: string) => Promise<boolean>;
/** LIVE mode: the owner's usable funds (the signal trader's funds read; FundsLike.available). */
export const REENTRY_FUNDS = Symbol('REENTRY_FUNDS');
/** LIVE mode: the env the signal trader's settings are read from (SL enforceability, mini fallback); process.env. */
export const REENTRY_ENV = Symbol('REENTRY_ENV');

/** The limits that, the first time they block in an IST day, send the owner one alert (§4.5). */
const STOP_LIMITS: ReadonlySet<ReentryLiveLimit> = new Set<ReentryLiveLimit>(['LOSS_STOP', 'DAILY_LOSS_STOP']);

const MIN = 60_000;
/** History read for the 1h EMA and N15 (as the entry engine reads). */
const BAR_HISTORY_DAYS = 6;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface UnderlyingContext {
  underlying: string;
  optionExchange: string;
  sessionOpen: boolean;
  minutesToClose: number | null;
  bars: Bar1m[];
  barSource: string;
  trend: TrendReading;
  noise: NoiseUnit | null;
  open: number;
  oi?: OiReading | null;
}

export interface WatchResult {
  watchKey: string;
  underlying: string | null;
  action: ReentryVerdict['action'];
  category: string;
  decisionId: string | null;
  opened: string | null;
  /** LIVE mode: the signal_orders row of a live re-entry order sent for this watch (PLACED / UNCERTAIN). */
  live?: string | null;
  note?: string;
}

/** One live-mode SIGNAL being decided (everything the live path and its paper fallback need). */
interface LiveSignal {
  id: string;
  key: string;
  x: ExitedPosition;
  ctx: UnderlyingContext;
  verdict: ReentryVerdict;
  original: Direction;
  ref: number | null;
  price: number | null;
  judged: EntryJudgeResult | null;
  liveCounts: LiveCounts | null;
  /** underlyingOpenOrInFlight read for this watch this tick (null = unreadable). */
  openOrInFlight: boolean | null;
  /** The run's decision time (bars, venue close, decision rows). The live gate reads nowFor() instead. */
  at: Date;
  /** Wall-clock ms when the run started (nowFor's fallback when the clock has no now()). */
  wallStart: number;
  result: WatchResult;
}

/** The entry engine's contract pick + plan for a re-entry (shared by the paper open and the live path). */
type PlannedContract =
  | { ok: false; reason: string }
  | { ok: true; p: EntryPlan; plan: Record<string, unknown>; kind: 'CE' | 'PE'; strike: number; expiry: string; ltp: number; pickNote: string; master: unknown[] };

const VENUE_OF: Record<string, LiveGateInput['venue']> = { NFO: 'NSE', NSE: 'NSE', BFO: 'BSE', BSE: 'BSE', MCX: 'MCX' };
const hhmmOfMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const istYmd = (at: Date) => new Date(at.getTime() + 330 * MIN).toISOString().slice(0, 10);

/**
 * RE-ENTRY WATCH (owner 2026-11-05; docs/superpowers/specs/2026-11-05-reentry-watch-design.md). Every 2 min:
 * every option position exited today (real trade_trackers, Telegram paper, entry-engine paper) is watched on
 * its underlying until the venue closes; decideReentry (pure) says SAME / OPPOSITE / wait. A watch's outcome is
 * recorded in reentry_watch_decisions whenever its category changes. REENTRY_WATCH=paper (default) opens a
 * PAPER trade for a SIGNAL through the entry engine's contract pick + plan + EntryEnginePaperService (isPaper:
 * true, strategy REENTRY_WATCH) and alerts the owner on Telegram. In paper mode nothing here can reach broker
 * order code.
 *
 * REENTRY_WATCH=live (docs/superpowers/specs/2026-11-23-reentry-live-design.md §4.2 / §6a): only a SIGNAL of a
 * REAL-source watch that the AI judge said ENTER on (mode on, call ok) goes to the live path: liveGate (counts
 * from the DATABASE, in-flight orders included) → contract + plan (the same pick as paper) → sizeLiveReentry
 * (₹ cap, funds, MCX mini) → SignalExecutorService.place (LIMIT, claim-first on the decision id, source
 * 'reentry' + the watch key on the claimed row). Anything that keeps it off the broker → the paper open as in
 * paper mode, with the limit stored on the decision row. Paper-source watches stay exactly as in paper mode.
 */
@Injectable()
export class ReentryWatchService {
  private readonly logger = new Logger(ReentryWatchService.name);
  private running = false;
  /** The last recorded category per watch (a row is written only when it changes). */
  private readonly last = new Map<string, string>();
  /** Per watch: when the AI entry judge may be asked again after declining (REENTRY_JUDGE_RETRY_MS). */
  private readonly judgeRetryAt = new Map<string, number>();
  /** LIVE: `<IST day>:<limit>` of the stop limits already alerted (one alert per day; alerts only, never a cap). */
  private readonly stopAlerted = new Set<string>();

  constructor(
    @Inject(REENTRY_WATCH_CONFIG) private readonly cfg: ReentryWatchConfig,
    @Inject(REENTRY_SIGNAL_CONFIG) private readonly signalCfg: SignalTraderConfig,
    @Inject(REENTRY_CLOCK) private readonly clock: ReentryClockLike,
    @Inject(REENTRY_MASTER) private readonly master: InstrumentMasterLike,
    @Inject(REENTRY_QUOTES) private readonly quotes: QuotesLike,
    private readonly repo: ReentryWatchRepository,
    private readonly engineRepo: EntryEngineRepository,
    private readonly signalRepo: SignalTraderRepository,
    private readonly oi: SignalOiCheckService,
    private readonly paper: EntryEnginePaperService,
    @Optional() @Inject(REENTRY_ALERT) private readonly alert?: AlertFn,
    // F4 (2026-11-16): the AI entry judge decides every SIGNAL before a re-entry is opened (ENTRY_AI_JUDGE).
    @Optional() private readonly judge?: EntryJudgeService,
    // LIVE mode (2026-11-23): the signal trader's live entry path, its funds read and its settings' env.
    @Optional() private readonly executor?: SignalExecutorService,
    @Optional() @Inject(REENTRY_FUNDS) private readonly funds?: FundsLike,
    @Optional() @Inject(REENTRY_ENV) private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const p of cfg.problems) this.logger.warn(`[reentry-watch] ${p}`);
  }

  @Cron('0 */2 9-23 * * *', { name: 'reentry-watch', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !bootJobsEnabled()) return;
    await this.run(new Date());
  }

  async run(now: Date): Promise<WatchResult[]> {
    if (this.cfg.mode === 'off' || this.running) return [];
    this.running = true;
    const wallStart = Date.now();
    const out: WatchResult[] = [];
    try {
      const dayStart = istDayAt(now, 0);
      let exits: ExitedPosition[];
      try {
        exits = await this.repo.exitsSince(dayStart);
      } catch (e) {
        this.logger.warn(`[reentry-watch] exits read failed: ${errText(e)}`);
        return [];
      }
      if (exits.length === 0) return [];
      let today = await this.repo.reentriesSince(dayStart).catch(() => Number.POSITIVE_INFINITY);
      const contexts = new Map<string, UnderlyingContext | null>();
      const uOf = (x: ExitedPosition) => (x.underlying && REENTRY_UNIVERSE.includes(x.underlying) ? x.underlying : null);
      for (const x of exits) {
        const u = uOf(x);
        if (u && !contexts.has(u)) contexts.set(u, await this.contextOf(u, now).catch((e) => (this.logger.warn(`[reentry-watch] ${u} context failed: ${errText(e)}`), null)));
      }
      // RANK BY STRENGTH (owner 2026-11-05): the daily cap goes to the strongest move first, not exit order — the
      // |move| in N15 from each exit point now (the same moveInN decideReentry uses).
      const strength = (x: ExitedPosition): number => {
        const ctx = uOf(x) ? contexts.get(uOf(x)!) ?? null : null;
        if (!ctx) return -1;
        const m = moveInN(directionOf(x.kind, x.side), underlyingAt(ctx.bars, x.exitAt), ctx.trend.price ?? null, ctx.noise?.n ?? null);
        return m === null ? -1 : Math.abs(m);
      };
      const ranked = [...exits].sort((a, b) => strength(b) - strength(a));
      for (const x of ranked) {
        try {
          const u = uOf(x);
          const ctx = u ? contexts.get(u) ?? null : null;
          const r = await this.watch(x, ctx, today, now, wallStart);
          if (r.opened) {
            today++;
            if (ctx) ctx.open++;
          }
          // A live order sent this run holds the underlying for the rest of the run (the DB check sees it next run).
          if (r.live && ctx) ctx.open++;
          out.push(r);
        } catch (e) {
          this.logger.warn(`[reentry-watch] ${watchKey(x)} failed: ${errText(e)}`);
          out.push({ watchKey: watchKey(x), underlying: x.underlying, action: 'SKIP', category: 'error', decisionId: null, opened: null, note: errText(e) });
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  /** The underlying's reads shared by every watch on it this run: session, bars, trend, N15, open positions. */
  private async contextOf(underlying: string, at: Date): Promise<UnderlyingContext | null> {
    const optionExchange = segmentFor({ underlying, instrumentKind: 'CE' });
    let sessionOpen = false;
    let minutesToClose: number | null = null;
    try {
      sessionOpen = this.clock.isOpen(optionExchange, at);
      minutesToClose = this.clock.minutesToClose(optionExchange, at);
    } catch {
      sessionOpen = false;
    }
    const sessionStart = sessionStartOf(optionExchange, at);
    const line = await this.lineOf(underlying, at);
    const from = new Date(at.getTime() - BAR_HISTORY_DAYS * 24 * 60 * MIN);
    const [hub, table] = line
      ? await Promise.all([this.engineRepo.hubBars(line.exchange, line.token, from, at), this.engineRepo.tableBars(line.exchange, line.token, from, at)])
      : [[], []];
    const chosen = chooseBars(hub, table, sessionStart, at);
    const open = await this.repo.openOnUnderlying(underlying);
    return {
      underlying, optionExchange, sessionOpen, minutesToClose, bars: chosen.bars, barSource: chosen.source,
      trend: trendReading(chosen.bars, at, sessionStart), noise: noise15(chosen.bars, at, noiseSessionOf(optionExchange)), open,
    };
  }

  private async lineOf(underlying: string, at: Date): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const index = INDEX_UNDERLYINGS[underlying.toUpperCase()];
    if (index) return { exchange: index.exchange, token: index.token, symbol: index.symbol };
    const fut = await this.signalRepo.nearestFuture(underlying, istDayAt(at, 0));
    return fut ? { exchange: fut.exchange, token: fut.token, symbol: fut.symbol } : null;
  }

  /** One watch: facts → decision → record on change → paper open + alert on a SIGNAL. */
  async watch(x: ExitedPosition, ctx: UnderlyingContext | null, reentriesToday: number, at: Date, wallStart: number = Date.now()): Promise<WatchResult> {
    const key = watchKey(x);
    const original = directionOf(x.kind, x.side);
    const stats = ctx ? await this.repo.reentriesOf(key) : { count: 0, lastExitAt: null };
    const ref = ctx ? underlyingAt(ctx.bars, x.exitAt) : null;
    const price = ctx?.trend.price ?? null;
    // LIVE (§6a.3): a REAL-source watch in live mode is capped by its DB counts (live orders in flight / filled +
    // paper re-entries) at the live per-trade cap, and the paper day cap does not apply. Counts unreadable ⇒ the
    // paper caps (and the gate later sees null ⇒ UNKNOWN_INPUT ⇒ paper).
    const liveSource = this.isLiveSource(x) && !!ctx;
    const liveCounts = liveSource ? await this.repo.liveCountsFor(key, istDayAt(at, 0)).catch((e) => (this.logger.warn(`[reentry-watch] ${key} live counts unreadable: ${errText(e)}`), null)) : null;
    // §6a.3d: for a live-eligible watch "the same underlying is open" also sees minis and in-flight live orders (DB),
    // so the watch WAITs on them instead of signalling into a paper twin. Unreadable ⇒ null: the paper rule as
    // before, and the gate later sees null ⇒ UNKNOWN_INPUT ⇒ paper.
    const openOrInFlight = liveSource && x.underlying
      ? await this.repo.underlyingOpenOrInFlight(x.underlying, istDayAt(at, 0)).catch((e) => (this.logger.warn(`[reentry-watch] ${x.underlying} open/in-flight unreadable: ${errText(e)}`), null))
      : null;
    // §6a.3d: live re-entries count for the cooldown too — the later of the paper re-entries' and the live ones' exits.
    const liveExit = liveCounts?.lastLiveExitAt ?? null;
    const lastReentryExitAt = liveExit && (!stats.lastExitAt || liveExit.getTime() > stats.lastExitAt.getTime()) ? liveExit : stats.lastExitAt;
    const base = {
      at, exitAt: x.exitAt, lastReentryExitAt, inUniverse: !!x.underlying && REENTRY_UNIVERSE.includes(x.underlying),
      sessionOpen: ctx?.sessionOpen ?? false, minutesToClose: ctx?.minutesToClose ?? null, ref, price,
      noise: ctx?.noise ?? null, trend: ctx?.trend ?? { lean: 'NO_DATA' as const, summary: 'not read' },
      oi: null as OiReading | null, reentriesForOriginal: liveCounts ? Math.max(stats.count, liveCounts.reentriesOfWatch) : stats.count, reentriesToday,
      openOnUnderlying: (ctx?.open ?? 0) + (openOrInFlight === true ? 1 : 0),
      ...(liveCounts ? { caps: { maxPerOriginal: this.cfg.live.maxPerTrade, maxPerDay: null } } : {}),
    };
    let verdict: ReentryVerdict = base.inUniverse && !ctx
      ? { action: 'WAIT', direction: null, enter: null, category: 'no-data', move: null, reasons: ["no data: the underlying's bars / session could not be read"] }
      : decideReentry(original, base);
    // The OI check is read only when the price and the trend already say OPPOSITE.
    if (ctx && verdict.action === 'SIGNAL' && verdict.direction === 'OPPOSITE') {
      if (ctx.oi === undefined) ctx.oi = await this.oiRead(ctx, verdict.enter as Direction, price, at);
      verdict = decideReentry(original, { ...base, oi: ctx.oi });
    }
    const result: WatchResult = { watchKey: key, underlying: x.underlying, action: verdict.action, category: verdict.category, decisionId: null, opened: null };
    if (this.last.get(key) === verdict.category) return result;
    // The AI judge declined this watch recently: unchanged until its retry time (no row, no new question).
    if (verdict.action === 'SIGNAL' && (this.judgeRetryAt.get(key) ?? 0) > at.getTime()) return result;
    this.last.set(key, verdict.category);

    const id = randomUUID();
    const best = ctx ? bestUnderlying(ctx.bars, x.entryAt, x.exitAt, original) : null;
    await this.repo.insertDecision({
      // The row's mode is what happened, not the switch: in live mode a row is 'paper' until a live order is actually
      // sent for it (settleLiveDecision then sets 'live', §4.4). Paper / off modes store the switch exactly as before.
      id, watchKey: key, underlying: x.underlying ?? '?', at, action: verdict.action, direction: verdict.direction, category: verdict.category, mode: this.cfg.mode === 'live' ? 'paper' : this.cfg.mode,
      inputs: {
        exited: { refTable: x.refTable, refId: x.refId, origin: x.origin, symbol: x.symbol, exchange: x.exchange, kind: x.kind, side: x.side, original, entryAt: x.entryAt, exitAt: x.exitAt, exitPrice: x.exitPrice },
        ref, best, price, noise: base.noise, move: verdict.move, trend: ctx?.trend ?? null, barSource: ctx?.barSource ?? null, oi: base.oi ?? ctx?.oi ?? null,
        counts: { reentriesForOriginal: stats.count, reentriesToday, openOnUnderlying: base.openOnUnderlying, minutesToClose: base.minutesToClose },
        ...(this.cfg.mode === 'live' ? { reentryWatch: 'live' } : {}),
        ...(liveSource ? { live: { counts: liveCounts, caps: base.caps ?? null, openOrInFlight } } : {}),
      },
      reasons: verdict.reasons,
    });
    result.decisionId = id;
    this.logger.log(`[reentry-watch] ${key} ${x.symbol} ${verdict.action} ${verdict.category} — ${verdict.reasons[0] ?? ''}`);
    if (verdict.action !== 'SIGNAL' || !ctx || !x.underlying) return result;
    if (this.cfg.mode !== 'paper' && this.cfg.mode !== 'live') return { ...result, note: 'not paper: nothing opened' };

    // AI ENTRY JUDGE: a rule trigger alone ("1 N past the exit point") never opens — the full analysis decides.
    const judged = this.judge
      ? await this.judge.judge(
          {
            source: 'REENTRY_WATCH',
            underlying: x.underlying,
            optionExchange: ctx.optionExchange,
            direction: verdict.enter as Direction,
            price,
            why: verdict.reasons,
            engineInputs: { reentryOf: { symbol: x.symbol, origin: x.origin, kind: x.kind, side: x.side, exitAt: x.exitAt, exitPrice: x.exitPrice }, underlyingAtExit: ref, move: verdict.move, direction: verdict.direction, trend: ctx.trend },
            userId: this.signalCfg.ownerUserId ?? null,
          },
          at,
        )
      : null;
    if (judged && !judged.open) {
      this.judgeRetryAt.set(key, at.getTime() + REENTRY_JUDGE_RETRY_MS);
      this.last.delete(key); // asked again after the retry time if the trigger still stands
      await this.repo.settleDecision(id, null, `paper: not opened — ${judged.note}`, null);
      // LIVE: a live-eligible signal the judge declined stores the limit that stopped it (§6a.7; nothing is opened, as in paper).
      if (liveSource) {
        await this.repo
          .settleLiveDecision(id, { mode: 'paper', limit: 'JUDGE', detail: `AI entry judge did not agree: ${judged.note}`.slice(0, 500) })
          .catch((e) => this.logger.warn(`[reentry-watch] ${key} live decision settle failed: ${errText(e)}`));
      }
      return { ...result, note: judged.note };
    }
    // LIVE: a REAL-source SIGNAL the judge let through → the live path (or its paper fallback with the limit).
    if (liveSource && ctx) return this.signalLive({ id, key, x, ctx, verdict, original, ref, price, judged, liveCounts, openOrInFlight, at, wallStart, result });
    const opened = await this.openPaper(id, key, x.underlying, verdict, price, at);
    if (judged) opened.note = `${opened.note}; ${judged.note}`;
    await this.repo.settleDecision(id, opened.tradeId, opened.note, opened.plan);
    const text = alertText({ underlying: x.underlying, original, verdict, exitAt: x.exitAt, ref, price, opened: opened.tradeId ? { tradingsymbol: opened.symbol ?? '?', price: opened.price } : null, note: opened.note });
    await (this.alert ?? sendOpsAlert)(`reentry-watch:${id}`, text).catch(() => false);
    return { ...result, opened: opened.tradeId, note: opened.note };
  }

  private async oiRead(ctx: UnderlyingContext, want: Direction, price: number | null, at: Date): Promise<OiReading | null> {
    try {
      const input = await this.oi.input({
        decisionId: '',
        signal: { underlying: ctx.underlying, instrumentKind: kindFor(want), strike: null },
        plan: { exchange: ctx.optionExchange, side: 'BUY', ltp: 0 },
        expiry: null,
        at,
      });
      if (input.chain && !(input.chain.center !== null && input.chain.center > 0) && price !== null && price > 0) {
        input.chain = { ...input.chain, center: price, centerSource: 'reentry-watch trend price (1m bars)' };
      }
      return readOi(input);
    } catch (e) {
      this.logger.warn(`[reentry-watch] ${ctx.underlying} OI read failed (NO_DATA): ${errText(e)}`);
      return null;
    }
  }

  /** The entry engine's contract pick (liquid ATM, nearest non-expiry-day expiry) + plan (1 lot, SL −25 %, T1 +50 %). */
  private async planContract(decisionId: string, underlying: string, v: ReentryVerdict, spot: number | null, at: Date): Promise<PlannedContract> {
    const fail = (reason: string): PlannedContract => ({ ok: false, reason });
    const kind = kindFor(v.enter as Direction);
    const owner = this.signalCfg.ownerUserId;
    if (!owner) return fail('HUB_OWNER_USER_ID is not set (no quote session)');
    let master: unknown[];
    try {
      master = await this.master.getInstrumentMaster();
    } catch (e) {
      return fail(`instrument master unavailable: ${errText(e)}`);
    }
    let cands = atmCandidates(master, underlying, kind, spot ?? 0, at);
    if (!cands.ok) return fail(cands.reason);
    // MCX: centre the ATM on the future the options are written on, not the (possibly other-month) price line.
    const centred = await optionFutureSpot({
      exchange: segmentFor({ underlying, instrumentKind: kind }),
      expiry: cands.expiry,
      spot: spot ?? 0,
      futures: () => this.signalRepo.mcxFutures(underlying, istDayAt(at, 0)),
      ltp: (token, exchange) => this.quotes.ltp(owner, token, exchange),
    });
    if (centred.spot !== (spot ?? 0)) {
      const again = atmCandidates(master, underlying, kind, centred.spot, at);
      if (again.ok) cands = again;
    }
    let liq: Awaited<ReturnType<EntryEngineRepository['strikeLiquidity']>> | null = null;
    try {
      liq = await this.engineRepo.strikeLiquidity(underlying, kind, cands.expiry, cands.strikes, sessionStartOf(segmentFor({ underlying, instrumentKind: kind }), at), new Date(at.getTime() - ENGINE_LIQUIDITY.recentMin * MIN));
    } catch (e) {
      this.logger.warn(`[reentry-watch] liquidity read failed for ${underlying} ${kind}: ${errText(e)} — ATM, unchecked`);
    }
    const pick = pickLiquidStrike(cands.strikes, liq);
    if (!pick.ok) return fail(pick.reason);
    // Resolved from the master by name / expiry / strike / type (never a token).
    const contract = engineContract(master, { underlying, instrumentKind: kind, strike: pick.strike, expiry: cands.expiry }, at);
    if (!contract.ok) return fail(contract.reason);
    const c = contract.contract;
    const ltp = await this.quotes.ltp(owner, c.token, c.exchange).catch(() => null);
    if (ltp === null || !(ltp > 0)) return fail(`no fresh LTP for ${c.tradingsymbol}`);
    const expiry = c.expiry ?? cands.expiry;
    const signal = engineSignal({ decisionId, underlying, kind, strike: pick.strike, expiry, ltp, tick: c.tickSize, at });
    const planned = planEngineEntry({ signal, contract, ltp, cfg: this.signalCfg });
    if (!planned.plan) {
      const failed = planned.checks.filter((x) => x.required && x.ok !== true).map((x) => `${x.name}: ${x.detail}`);
      return fail(`plan refused (${failed.join('; ') || 'no plan'})`);
    }
    const p = planned.plan;
    const plan = { tradingsymbol: p.tradingsymbol, token: p.token, exchange: p.exchange, side: p.side, ltp: p.ltp, limitPrice: p.limitPrice, sl: p.sl, targets: p.targets, lotSize: p.lotSize, qty: p.qty, tickSize: p.tickSize };
    return { ok: true, p, plan, kind, strike: pick.strike, expiry, ltp, pickNote: centred.note ? `${pick.note}; ${centred.note}` : pick.note, master };
  }

  /** The entry engine's contract pick (liquid ATM, nearest non-expiry-day expiry) + plan → PAPER open. */
  private async openPaper(decisionId: string, key: string, underlying: string, v: ReentryVerdict, spot: number | null, at: Date): Promise<{ tradeId: string | null; note: string; plan: unknown; symbol?: string; price: number | null }> {
    const fail = (note: string) => ({ tradeId: null, note: `paper: not opened — ${note}`, plan: null, price: null });
    const planned = await this.planContract(decisionId, underlying, v, spot, at);
    if (!planned.ok) return fail(planned.reason);
    const { p, plan, kind, strike, expiry, ltp, pickNote } = planned;
    const r = await this.paper.open({
      decisionId, plan: p, underlying, kind, strike, expiry, why: v.reasons[0] ?? '',
      brand: {
        strategy: REENTRY_STRATEGY, source: REENTRY_SOURCE, label: `Re-entry watch ${v.direction?.toLowerCase()} direction`,
        tags: [REENTRY_TAG, decisionTag(decisionId), `underlying:${underlying.toUpperCase()}`, `${REENTRY_OF_TAG}${key}`, `reentry:${String(v.direction).toLowerCase()}`],
      },
    });
    return r.ok
      ? { tradeId: r.tradeId, note: `paper: opened ${p.tradingsymbol} x${p.qty} @ ${r.entryPrice ?? ltp} (trade ${r.tradeId}); ${pickNote}`, plan, symbol: p.tradingsymbol, price: r.entryPrice ?? ltp }
      : { tradeId: null, note: `paper: open failed — ${r.reason}`, plan, price: null };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // LIVE mode (docs/superpowers/specs/2026-11-23-reentry-live-design.md §4.2, §6a)
  // ---------------------------------------------------------------------------------------------------------------

  /** Only a REAL exit in REENTRY_WATCH=live may re-enter live (§3 #1); everything else is paper as before. */
  private isLiveSource(x: ExitedPosition): boolean {
    // Only the signal trader's OWNER's trackers (HUB_OWNER_USER_ID — the account the live order would trade). Every
    // other user's exit, or a row with no user, is watched exactly as in paper mode (review fix 2026-11-23).
    const owner = this.signalCfg.ownerUserId;
    return this.cfg.mode === 'live' && x.origin === 'REAL' && !!owner && x.userId === owner && !!x.underlying && REENTRY_UNIVERSE.includes(x.underlying);
  }

  /**
   * The current instant for the live gate (review fix 2026-11-23): the injected clock's now() when it has one, else
   * the run's start plus the wall time elapsed since — never the run's start alone (the AI judge takes 10-20 s).
   */
  private nowFor(s: Pick<LiveSignal, 'at' | 'wallStart'>): Date {
    const now = this.clock.now?.();
    if (now instanceof Date && Number.isFinite(now.getTime())) return now;
    return new Date(s.at.getTime() + Math.max(0, Date.now() - s.wallStart));
  }

  /**
   * Restart recovery (review fix 2026-11-23): live re-entry orders sent before a restart are followed again, so an
   * unfilled LIMIT is still cancelled after the fill wait and a fill is still handed to the sentinel. The signal
   * trader's own bootstrap already resumes every PLACED row of today (any source) when SIGNAL_TRADING=live — then
   * only UNCERTAIN re-entry rows are taken here (never followed twice); otherwise PLACED + UNCERTAIN. Runs in every
   * REENTRY_WATCH mode: after a rollback to paper a resting live order must still be cancelled / settled.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.executor || !bootJobsEnabled()) return;
    const statuses = this.signalCfg.mode === 'live' ? ['UNCERTAIN'] : ['PLACED', 'UNCERTAIN'];
    try {
      const rows = await this.repo.pendingLiveReentryOrders(istDayAt(new Date(), 0), statuses);
      if (rows.length === 0) return;
      this.logger.warn(`[reentry-watch] resuming ${rows.length} live re-entry order(s) after a restart (${statuses.join('/')})`);
      await this.executor.resume(rows, this.signalCfg.fillWaitSec);
    } catch (e) {
      this.logger.error(`[reentry-watch] resuming live re-entry orders failed: ${errText(e)}`);
    }
  }

  /**
   * One live-mode SIGNAL of a REAL-source watch: gate → plan → size → send, or the paper fallback with the limit.
   * Never two orders for one intent: the executor claims the decision id before the broker call, and every cap
   * reads the DB (in-flight orders included).
   */
  private async signalLive(s: LiveSignal): Promise<WatchResult> {
    const u = s.x.underlying as string;
    const { input, audit } = await this.gateInput(s);
    const gate = liveGate(input, this.cfg.live);
    if (!gate.live) return this.paperFallback(s, gate.limit, gate.detail, audit);
    if (!isLiveTradingEnabled()) return this.paperFallback(s, 'MODE', 'LIVE_TRADING_ENABLED is not true', audit);
    if (!this.executor) return this.paperFallback(s, 'UNKNOWN_INPUT', 'live executor not wired', audit);
    const owner = this.signalCfg.ownerUserId;
    if (!owner) return this.paperFallback(s, 'UNKNOWN_INPUT', 'HUB_OWNER_USER_ID is not set', audit);

    const planned = await this.planContract(s.id, u, s.verdict, s.price, s.at);
    if (!planned.ok) return this.paperFallback(s, 'NO_SIZE', `no live plan: ${planned.reason}`, audit);
    const sized = await this.sizeLive(planned, u, owner, s.at);
    if (sized.size.kind === 'NONE' || !sized.plan) {
      const none = sized.size.kind === 'NONE' ? sized.size : { limit: 'NO_SIZE' as const, detail: 'no plan for the size' };
      return this.paperFallback(s, none.limit, none.detail, `${audit} ${sized.note}`);
    }
    const plan = sized.plan;
    // The SL must be executable by the sentinel's price trigger → AI exit (and the qty unit known) — as for signals.
    const slEnf = slEnforceability(this.env, owner, plan.exchange, plan.tradingsymbol);
    if (!slEnf.ok) return this.paperFallback(s, 'UNKNOWN_INPUT', `SL not enforceable: ${slEnf.detail}`, audit);

    // The contract / LTP / funds reads took time too: the time window is re-checked last thing before the order
    // (review fix 2026-11-23). Every other input is unchanged, so only TIME_WINDOW can newly block here.
    const late = liveGate({ ...input, atIst: this.nowFor(s) }, this.cfg.live);
    if (!late.live) return this.paperFallback(s, late.limit, `${late.detail} (re-checked just before the order)`, audit);

    const what = `Re-entry ${String(s.verdict.direction).toLowerCase()} ${u} ${planned.kind} (of ${s.key})`;
    let fallbackDone = false;
    let fallback: WatchResult | null = null;
    let placed: PlaceResult;
    try {
      placed = await this.executor.place({
        decisionId: s.id,
        ownerUserId: owner,
        plan,
        product: this.signalCfg.product,
        qtyUnit: slEnf.qtyUnit,
        channel: 'reentry-watch',
        signalSummary: what,
        fillWaitSec: this.signalCfg.fillWaitSec,
        source: 'reentry',
        reentryWatchKey: s.key,
        // A funds / margin rejection (now or later in the book) → the paper fallback, once.
        onRejected: async (reason) => {
          if (!isFundsRejection(reason)) {
            await this.settleLive(s, { note: `live: broker rejected — ${reason.slice(0, 300)}` });
            return;
          }
          if (fallbackDone) return;
          fallbackDone = true;
          fallback = await this.paperFallback(s, 'NO_FUNDS', `broker rejected for funds: ${reason.slice(0, 300)}`, audit);
        },
      });
    } catch (e) {
      // The executor threw: the order state is not known (it may have been sent) — never a paper twin, never a retry.
      const detail = `live executor error — order state unknown, check the broker: ${errText(e)}`;
      this.logger.error(`[reentry-watch] ${s.key} ${detail}`);
      await this.settleLive(s, { limit: 'UNKNOWN_INPUT', detail, note: `live: ${detail}` });
      return { ...s.result, note: detail };
    }

    const order = `LIMIT ${plan.side} ${plan.tradingsymbol} x${plan.qty} (${sized.size.kind === 'MINI' ? `${plan.lots} mini lot(s)` : '1 lot'}) @ ${plan.limitPrice}, SL ${plan.sl}`;
    switch (placed.kind) {
      case 'DUPLICATE': {
        const note = 'live: this decision already has an order — nothing sent';
        await this.settleLive(s, { note });
        return { ...s.result, note };
      }
      case 'PLACED':
      case 'UNCERTAIN': {
        const sure = placed.kind === 'PLACED';
        const note = placed.kind === 'PLACED'
          ? `live: placed ${order} (order ${placed.brokerOrderId}, row ${placed.orderRowId}); risk ₹${sized.size.riskRupees} ${audit}`
          : `live: UNCERTAIN ${order} — the order MAY exist, check the broker (${placed.reason}) ${audit}`;
        await this.settleLive(s, { mode: 'live', signalOrderId: placed.orderRowId, note });
        await this.liveAlert(s, sure ? `placed ${order}` : `order UNCERTAIN ${order} — it may exist, check the broker`);
        return { ...s.result, live: placed.orderRowId, note };
      }
      case 'REJECTED': {
        // A funds rejection already went to the paper fallback through onRejected (once).
        const note = `live: REJECTED ${order} — ${placed.reason}${fallbackDone ? ' → paper fallback' : ''}`;
        await this.settleLive(s, { signalOrderId: placed.orderRowId, note, ...(fallbackDone ? {} : { detail: `broker rejected: ${placed.reason}`.slice(0, 500) }) });
        const fb =fallback as WatchResult | null;
        return fb ? { ...fb, note: `${note}; ${fb.note ?? ''}` } : { ...s.result, note };
      }
      case 'BLOCKED':
        await this.settleLive(s, { signalOrderId: placed.orderRowId });
        return this.paperFallback(s, 'MODE', `blocked at send: ${placed.reason}`, audit);
      case 'FAILED':
      default:
        await this.settleLive(s, { signalOrderId: placed.orderRowId });
        return this.paperFallback(s, 'UNKNOWN_INPUT', `not sent: ${placed.reason}`, audit);
    }
  }

  /** The gate's inputs (the DB counts, the shared daily stop, the same-underlying check, IST time + venue). */
  private async gateInput(s: LiveSignal): Promise<{ input: LiveGateInput; audit: string }> {
    const u = s.x.underlying as string;
    const dayStart = istDayAt(s.at, 0);
    // Read AFTER the AI judge call (10-20 s): the counts and the same-underlying check are re-read here, right before
    // the gate decision, not taken from before the judge (review fix 2026-11-23). Unreadable ⇒ null ⇒ UNKNOWN_INPUT.
    const [lossToday, openOrInFlight, c] = await Promise.all([
      this.signalRepo.signalLossToday(s.at).catch((e) => (this.logger.warn(`[reentry-watch] signal loss today unreadable: ${errText(e)}`), null)),
      this.repo.underlyingOpenOrInFlight(u, dayStart).catch((e) => (this.logger.warn(`[reentry-watch] ${u} open/in-flight unreadable: ${errText(e)}`), null)),
      this.repo.liveCountsFor(s.key, dayStart).catch((e) => (this.logger.warn(`[reentry-watch] ${s.key} live counts unreadable: ${errText(e)}`), null)),
    ]);
    const stop = this.signalCfg.dailyLossStop;
    const dailyLossStopHit = typeof lossToday === 'number' && Number.isFinite(lossToday) && typeof stop === 'number' && stop > 0 ? lossToday >= stop : null;
    // The venue close stays the one captured with the run (s.at + its minutes-to-close); the gate's "now" is the
    // clock's current time (review fix 2026-11-23), so time spent in the judge counts against the window.
    const mtc = s.ctx.minutesToClose;
    const venueCloseIst = typeof mtc === 'number' && Number.isFinite(mtc) ? hhmmOfMin((((istMinuteOf(s.at) + Math.round(mtc)) % 1440) + 1440) % 1440) : null;
    const j = s.judged;
    const input: LiveGateInput = {
      mode: this.cfg.mode,
      source: this.isLiveSource(s.x) ? 'REAL' : 'PAPER',
      judge: j ? { mode: j.mode, decision: j.ok ? j.verdict.decision : null, ok: j.ok } : { mode: 'none', decision: null, ok: false },
      reentriesOfWatch: c ? c.reentriesOfWatch : null,
      liveToday: c ? c.liveToday : null,
      liveLossesToday: c ? c.liveLossesToday : null,
      dailyLossStopHit,
      underlyingOpenOrInFlight: typeof openOrInFlight === 'boolean' ? openOrInFlight : null,
      venue: VENUE_OF[String(s.ctx.optionExchange).toUpperCase()] ?? (String(s.ctx.optionExchange) as LiveGateInput['venue']),
      underlying: u,
      atIst: this.nowFor(s),
      venueCloseIst,
    };
    const audit =
      `[watch ${c?.reentriesOfWatch ?? '?'}/${this.cfg.live.maxPerTrade}, live today ${c?.liveToday ?? '?'}/${this.cfg.live.maxPerDay}, ` +
      `losses ${c?.liveLossesToday ?? '?'}/${this.cfg.live.maxLosses}, real loss today ${lossToday === null ? '?' : `₹${Math.round(lossToday)}`}/₹${stop}, ` +
      `open/in-flight ${openOrInFlight === null ? '?' : openOrInFlight ? 'yes' : 'no'}, close ${venueCloseIst ?? '?'}]`;
    return { input, audit };
  }

  /** §3 #3/#4/#13: 1 full lot within the ₹ cap and the funds, else the MCX mini, else none (with the limit). */
  private async sizeLive(planned: Extract<PlannedContract, { ok: true }>, underlying: string, owner: string, at: Date): Promise<{ size: LiveSize; plan: EntryPlan | null; note: string }> {
    const { p, kind, strike, expiry, ltp, master } = planned;
    if (p.lots !== 1 || p.side !== 'BUY') return { size: { kind: 'NONE', limit: 'NO_SIZE', detail: `plan is ${p.side} ${p.lots} lot(s), not BUY 1 lot` }, plan: null, note: '' };
    const available = await this.readFunds(owner);
    const fundsOk = (plan: EntryPlan): boolean | null =>
      available === null ? null : fundsCheck(available, requiredFunds(plan, { instrumentKind: kind, strike }, this.signalCfg)).funds.ok;
    const cap = this.cfg.live.riskRupees;
    const maxLots = miniMaxLots(this.env);
    const base = { underlying, fullSymbol: p.tradingsymbol, entry: p.limitPrice, sl: p.sl, lotSize: p.lotSize, fundsOkFull: fundsOk(p), riskCapRupees: cap, miniMaxLots: maxLots };
    const note = `[funds ${available === null ? 'unknown' : `₹${Math.round(available)}`}]`;
    const full = sizeLiveReentry({ ...base, mini: null });
    if (full.kind === 'FULL') return { size: full, plan: p, note };

    // MCX mini (GOLDM / CRUDEOILM / NATGASMINI; SILVER has none): the same strike + expiry, priced from its own LTP.
    const miniName = miniNameFor(underlying);
    if (!miniName || !miniFallbackOn(this.env) || p.exchange !== 'MCX') return { size: full, plan: null, note };
    let miniPlan: EntryPlan | null = null;
    let miniWhy = '';
    try {
      const res = engineContract(master, { underlying: miniName, instrumentKind: kind, strike, expiry }, at);
      if (!res.ok) miniWhy = `no ${miniName} contract: ${res.reason}`;
      else {
        const miniLtp = await this.quotes.ltp(owner, res.contract.token, res.contract.exchange).catch(() => null);
        // Sized on risk only here (available null); the funds are applied lot by lot in sizeLiveReentry.
        const r = planMini({ plan: p, mini: res.contract, miniLtp, fullLtp: ltp, cap, available: null, fundsBufferPct: this.signalCfg.fundsBufferPct, maxLots });
        if (r.ok) miniPlan = r.plan;
        else miniWhy = `mini not taken: ${r.reason}`;
      }
    } catch (e) {
      miniWhy = `mini failed: ${errText(e)}`;
    }
    if (!miniPlan) {
      const detail = full.kind === 'NONE' ? `${full.detail}; ${miniWhy}` : miniWhy;
      return { size: { kind: 'NONE', limit: full.kind === 'NONE' ? full.limit : 'NO_SIZE', detail }, plan: null, note };
    }
    const m = miniPlan;
    const size = sizeLiveReentry({
      ...base,
      mini: { symbol: m.tradingsymbol, lotSize: m.lotSize, entry: m.limitPrice, sl: m.sl, fundsOkLots: (lots) => fundsOk({ ...m, lots, qty: lots * m.lotSize }) },
    });
    if (size.kind === 'FULL') return { size, plan: p, note };
    if (size.kind === 'NONE') return { size, plan: null, note };
    return { size, plan: { ...m, lots: size.lots, qty: size.lots * m.lotSize, riskRupees: size.riskRupees }, note };
  }

  /** The owner's usable funds (the signal trader's read); null = unknown. Never throws. */
  private async readFunds(owner: string): Promise<number | null> {
    if (!this.funds) return null;
    try {
      const v = await this.funds.available(owner);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch (e) {
      this.logger.warn(`[reentry-watch] funds read failed (unknown): ${errText(e)}`);
      return null;
    }
  }

  /**
   * A live-eligible SIGNAL that does not go live: the paper open exactly as in paper mode, with the limit stored
   * (limit_hit / limit_detail, and in the reasons line). MAX_PER_TRADE opens nothing: the watch's re-entries
   * (live + paper together, §6a.3a) are used up.
   */
  private async paperFallback(s: LiveSignal, limit: ReentryLiveLimit, detail: string, audit: string): Promise<WatchResult> {
    const u = s.x.underlying as string;
    this.logger.log(`[reentry-watch] ${s.key} live-eligible SIGNAL → paper: ${limit} — ${detail}`);
    await this.stopAlert(s, limit, detail);
    if (limit === 'MAX_PER_TRADE') {
      const note = `live: not placed — ${limit}: ${detail}; no paper (the watch's re-entries are used up) ${audit}`;
      await this.repo.settleDecision(s.id, null, note, null);
      await this.settleLive(s, { mode: 'paper', limit, detail });
      return { ...s.result, note };
    }
    const opened = await this.openPaper(s.id, s.key, u, s.verdict, s.price, s.at);
    opened.note = `${opened.note}; live: ${limit} — ${detail} ${audit}`;
    if (s.judged) opened.note = `${opened.note}; ${s.judged.note}`;
    await this.repo.settleDecision(s.id, opened.tradeId, opened.note, opened.plan);
    await this.settleLive(s, { mode: 'paper', limit, detail, tradeId: opened.tradeId });
    const text = alertText({ underlying: u, original: s.original, verdict: s.verdict, exitAt: s.x.exitAt, ref: s.ref, price: s.price, opened: opened.tradeId ? { tradingsymbol: opened.symbol ?? '?', price: opened.price } : null, note: opened.note });
    await (this.alert ?? sendOpsAlert)(`reentry-watch:${s.id}`, `${text} (live: ${limit})`).catch(() => false);
    return { ...s.result, opened: opened.tradeId, note: opened.note };
  }

  /** settleLiveDecision, logged on failure (a missing migration must not break the paper fallback). */
  private async settleLive(s: LiveSignal, p: Parameters<ReentryWatchRepository['settleLiveDecision']>[1]): Promise<void> {
    await this.repo.settleLiveDecision(s.id, p).catch((e) => this.logger.warn(`[reentry-watch] ${s.key} live decision settle failed: ${errText(e)}`));
  }

  /** One owner alert per live order sent (§4.5). */
  private async liveAlert(s: LiveSignal, what: string): Promise<void> {
    const u = s.x.underlying as string;
    const enter = s.verdict.enter ?? s.original;
    const text = `Re-entry (LIVE): ${u} ${kindFor(enter)} ${s.verdict.direction === 'SAME' ? 'same' : 'opposite'} direction after ${s.x.symbol} — ${u} ${s.price ?? '?'} vs the exit point ${s.ref ?? '?'}; ${what}`;
    await (this.alert ?? sendOpsAlert)(`reentry-live:${s.id}`, text).catch(() => false);
  }

  /** LOSS_STOP / DAILY_LOSS_STOP: one owner alert the first time each blocks in an IST day (§4.5). */
  private async stopAlert(s: LiveSignal, limit: ReentryLiveLimit, detail: string): Promise<void> {
    if (!STOP_LIMITS.has(limit)) return;
    const k = `${istYmd(s.at)}:${limit}`;
    if (this.stopAlerted.has(k)) return;
    this.stopAlerted.add(k);
    const text = `Re-entry LIVE stopped for today (${limit}): ${detail}. Live-eligible re-entries go to paper until tomorrow.`;
    await (this.alert ?? sendOpsAlert)(`reentry-live-stop:${k}`, text).catch(() => false);
  }
}
