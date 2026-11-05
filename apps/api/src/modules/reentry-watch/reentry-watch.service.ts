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
import { atmCandidates, engineContract, engineSignal, ENGINE_LIQUIDITY, pickLiquidStrike, planEngineEntry } from '../entry-engine/domain/engine-contract';
import { chooseBars, istDayAt, readOi, sessionStartOf } from '../entry-engine/domain/engine-inputs';
import { trendReading, type Bar1m, type Direction, type OiReading, type TrendReading } from '../entry-engine/domain/entry-decision';
import { EntryEnginePaperService } from '../entry-engine/entry-engine-paper.service';
import { EntryEngineRepository } from '../entry-engine/entry-engine.repository';
import {
  alertText, bestUnderlying, decideReentry, directionOf, kindFor, noise15, noiseSessionOf, REENTRY_UNIVERSE, underlyingAt, watchKey,
  type ExitedPosition, type NoiseUnit, type ReentryVerdict,
} from './domain/reentry-rules';
import { REENTRY_OF_TAG, REENTRY_SOURCE, REENTRY_STRATEGY, REENTRY_TAG, REENTRY_WATCH_CONFIG, type ReentryWatchConfig } from './reentry-watch.config';
import { ReentryWatchRepository } from './reentry-watch.repository';

export const REENTRY_CLOCK = Symbol('REENTRY_CLOCK');
export const REENTRY_MASTER = Symbol('REENTRY_MASTER');
export const REENTRY_QUOTES = Symbol('REENTRY_QUOTES');
export const REENTRY_SIGNAL_CONFIG = Symbol('REENTRY_SIGNAL_CONFIG');
/** The owner alert (sendOpsAlert); a token so tests can watch it. */
export const REENTRY_ALERT = Symbol('REENTRY_ALERT');
export type AlertFn = (key: string, text: string) => Promise<boolean>;

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
  note?: string;
}

/**
 * RE-ENTRY WATCH (owner 2026-11-05; docs/superpowers/specs/2026-11-05-reentry-watch-design.md). Every 2 min:
 * every option position exited today (real trade_trackers, Telegram paper, entry-engine paper) is watched on
 * its underlying until the venue closes; decideReentry (pure) says SAME / OPPOSITE / wait. A watch's outcome is
 * recorded in reentry_watch_decisions whenever its category changes. REENTRY_WATCH=paper (default) opens a
 * PAPER trade for a SIGNAL through the entry engine's contract pick + plan + EntryEnginePaperService (isPaper:
 * true, strategy REENTRY_WATCH) and alerts the owner on Telegram. There is no live mode: nothing here can
 * reach broker order code.
 */
@Injectable()
export class ReentryWatchService {
  private readonly logger = new Logger(ReentryWatchService.name);
  private running = false;
  /** The last recorded category per watch (a row is written only when it changes). */
  private readonly last = new Map<string, string>();

  constructor(
    @Inject(REENTRY_WATCH_CONFIG) private readonly cfg: ReentryWatchConfig,
    @Inject(REENTRY_SIGNAL_CONFIG) private readonly signalCfg: SignalTraderConfig,
    @Inject(REENTRY_CLOCK) private readonly clock: SessionClockLike,
    @Inject(REENTRY_MASTER) private readonly master: InstrumentMasterLike,
    @Inject(REENTRY_QUOTES) private readonly quotes: QuotesLike,
    private readonly repo: ReentryWatchRepository,
    private readonly engineRepo: EntryEngineRepository,
    private readonly signalRepo: SignalTraderRepository,
    private readonly oi: SignalOiCheckService,
    private readonly paper: EntryEnginePaperService,
    @Optional() @Inject(REENTRY_ALERT) private readonly alert?: AlertFn,
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
      for (const x of exits) {
        try {
          const u = x.underlying && REENTRY_UNIVERSE.includes(x.underlying) ? x.underlying : null;
          if (u && !contexts.has(u)) contexts.set(u, await this.contextOf(u, now).catch((e) => (this.logger.warn(`[reentry-watch] ${u} context failed: ${errText(e)}`), null)));
          const ctx = u ? contexts.get(u) ?? null : null;
          const r = await this.watch(x, ctx, today, now);
          if (r.opened) {
            today++;
            if (ctx) ctx.open++;
          }
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
  async watch(x: ExitedPosition, ctx: UnderlyingContext | null, reentriesToday: number, at: Date): Promise<WatchResult> {
    const key = watchKey(x);
    const original = directionOf(x.kind, x.side);
    const stats = ctx ? await this.repo.reentriesOf(key) : { count: 0, lastExitAt: null };
    const ref = ctx ? underlyingAt(ctx.bars, x.exitAt) : null;
    const price = ctx?.trend.price ?? null;
    const base = {
      at, exitAt: x.exitAt, lastReentryExitAt: stats.lastExitAt, inUniverse: !!x.underlying && REENTRY_UNIVERSE.includes(x.underlying),
      sessionOpen: ctx?.sessionOpen ?? false, minutesToClose: ctx?.minutesToClose ?? null, ref, price,
      noise: ctx?.noise ?? null, trend: ctx?.trend ?? { lean: 'NO_DATA' as const, summary: 'not read' },
      oi: null as OiReading | null, reentriesForOriginal: stats.count, reentriesToday, openOnUnderlying: ctx?.open ?? 0,
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
    this.last.set(key, verdict.category);

    const id = randomUUID();
    const best = ctx ? bestUnderlying(ctx.bars, x.entryAt, x.exitAt, original) : null;
    await this.repo.insertDecision({
      id, watchKey: key, underlying: x.underlying ?? '?', at, action: verdict.action, direction: verdict.direction, category: verdict.category, mode: this.cfg.mode,
      inputs: {
        exited: { refTable: x.refTable, refId: x.refId, origin: x.origin, symbol: x.symbol, exchange: x.exchange, kind: x.kind, side: x.side, original, entryAt: x.entryAt, exitAt: x.exitAt, exitPrice: x.exitPrice },
        ref, best, price, noise: base.noise, move: verdict.move, trend: ctx?.trend ?? null, barSource: ctx?.barSource ?? null, oi: base.oi ?? ctx?.oi ?? null,
        counts: { reentriesForOriginal: stats.count, reentriesToday, openOnUnderlying: base.openOnUnderlying, minutesToClose: base.minutesToClose },
      },
      reasons: verdict.reasons,
    });
    result.decisionId = id;
    this.logger.log(`[reentry-watch] ${key} ${x.symbol} ${verdict.action} ${verdict.category} — ${verdict.reasons[0] ?? ''}`);
    if (verdict.action !== 'SIGNAL' || !ctx || !x.underlying) return result;
    if (this.cfg.mode !== 'paper') return { ...result, note: 'not paper: nothing opened' };

    const opened = await this.openPaper(id, key, x.underlying, verdict, price, at);
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

  /** The entry engine's contract pick (liquid ATM, nearest non-expiry-day expiry) + plan → PAPER open. */
  private async openPaper(decisionId: string, key: string, underlying: string, v: ReentryVerdict, spot: number | null, at: Date): Promise<{ tradeId: string | null; note: string; plan: unknown; symbol?: string; price: number | null }> {
    const fail = (note: string) => ({ tradeId: null, note: `paper: not opened — ${note}`, plan: null, price: null });
    const kind = kindFor(v.enter as Direction);
    const owner = this.signalCfg.ownerUserId;
    if (!owner) return fail('HUB_OWNER_USER_ID is not set (no quote session)');
    let master: unknown[];
    try {
      master = await this.master.getInstrumentMaster();
    } catch (e) {
      return fail(`instrument master unavailable: ${errText(e)}`);
    }
    const cands = atmCandidates(master, underlying, kind, spot ?? 0, at);
    if (!cands.ok) return fail(cands.reason);
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
    const r = await this.paper.open({
      decisionId, plan: p, underlying, kind, strike: pick.strike, expiry, why: v.reasons[0] ?? '',
      brand: {
        strategy: REENTRY_STRATEGY, source: REENTRY_SOURCE, label: `Re-entry watch ${v.direction?.toLowerCase()} direction`,
        tags: [REENTRY_TAG, decisionTag(decisionId), `underlying:${underlying.toUpperCase()}`, `${REENTRY_OF_TAG}${key}`, `reentry:${String(v.direction).toLowerCase()}`],
      },
    });
    return r.ok
      ? { tradeId: r.tradeId, note: `paper: opened ${p.tradingsymbol} x${p.qty} @ ${r.entryPrice ?? ltp} (trade ${r.tradeId}); ${pick.note}`, plan, symbol: p.tradingsymbol, price: r.entryPrice ?? ltp }
      : { tradeId: null, note: `paper: open failed — ${r.reason}`, plan, price: null };
  }
}
