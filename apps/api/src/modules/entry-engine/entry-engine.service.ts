import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { INDEX_UNDERLYINGS } from '../market-hub/underlying';
import { eventContextFor, type EventContext } from '../news-events/events/event-context';
import { MarketEventsRepository } from '../news-events/events/market-events.repository';
import { segmentFor } from '../signal-trader/domain/contract-resolver';
import type { SignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';
import { SignalOiCheckService } from '../signal-trader/services/signal-oi-check.service';
import type { InstrumentMasterLike, QuotesLike, SessionClockLike } from '../signal-trader/services/signal-trader.service';
import { loadTrendBars } from '../signal-trader/services/trend-bars.loader';
import { atmCandidates, engineContract, engineSignal, ENGINE_LIQUIDITY, pickLiquidStrike, planEngineEntry } from './domain/engine-contract';
import { chooseBars, ENGINE_UNIVERSE, ENGINE_WINDOW, istDayAt, istMinutes, readOi, sessionStartOf, wantFor } from './domain/engine-inputs';
import { ENTRY_ENGINE, entryDecision, entryGuards, INPUT_NOT_READY, isEnterAction, newsReading, trendReading, type Bar1m, type Direction, type EngineAction, type EntryDecision, type GuardResult, type OiReading } from './domain/entry-decision';
import { applyEntryGates, clusterGate, extensionReading, gateLine, INDEX_CLUSTER, inIndexCluster, indicatorReading, sessionBars, type ExtensionReading, type GateResult, type IndicatorReading } from './domain/entry-gates';
import { withNewsPaths } from './domain/news-paths';
import { NEWS_THEME, newsTheme } from './domain/news-theme';
import { ENTRY_ENGINE_CONFIG, type EntryEngineConfig } from './entry-engine.config';
import { EntryEnginePaperService } from './entry-engine-paper.service';
import { EntryEngineRepository } from './entry-engine.repository';

export const ENGINE_CLOCK = Symbol('ENGINE_CLOCK');
export const ENGINE_MASTER = Symbol('ENGINE_MASTER');
export const ENGINE_QUOTES = Symbol('ENGINE_QUOTES');
/** The signal-trader config the plan is built with (owner id, caps, tolerance). */
export const ENGINE_SIGNAL_CONFIG = Symbol('ENGINE_SIGNAL_CONFIG');

const MIN = 60_000;
const istYmdOf = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** History read for the 1h EMA (≥ 11 hourly closes: two NSE sessions, over a weekend). */
const BAR_HISTORY_DAYS = 6;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface EvaluationResult {
  underlying: string;
  decisionId: string | null;
  action: EngineAction | 'SKIPPED';
  opened: string | null;
  note?: string;
}

/** One scan pass (all underlyings at one cron tick): the index-cluster underlyings already entered in it. */
export interface ScanPass {
  clusterEntered: string[];
}

/**
 * ENTRY ENGINE stage 1 — the intraday idea pass (owner 2026-10-30). Every 15 min (IST :05/:20/:35/:50,
 * 09:20–23:00, venue open), for each underlying of the fixed universe: the news read of the last 60
 * min (news_impacts — the same model read the 08:40 news-ideas batch ranks with; that batch is left
 * unchanged), the trend from 1-minute bars, and the OI check (signal-trader SignalOiCheckService, DB
 * reads only) → entryDecision (code, deterministic) → the entry gates (2026-11-11, domain/entry-gates.ts:
 * 15m EMA/MACD/RSI indicators → NO_TRADE / WAIT, chase in N15 → WAIT, index-cluster cap → not opened).
 * EVERY evaluation is recorded in entry_engine_decisions, NO_TRADE and WAIT included.
 *
 * ENTRY_ENGINE=paper also opens a PAPER trade for an ENTER that passes the cooldowns (ATM option,
 * nearest non-expiry-day expiry, 1 lot, signal-trader planEntry, isPaper: true). observe (default)
 * opens nothing. There is no live mode and nothing here can reach broker order code.
 */
@Injectable()
export class EntryEngineService {
  private readonly logger = new Logger(EntryEngineService.name);
  private running = false;

  constructor(
    @Inject(ENTRY_ENGINE_CONFIG) private readonly cfg: EntryEngineConfig,
    @Inject(ENGINE_SIGNAL_CONFIG) private readonly signalCfg: SignalTraderConfig,
    @Inject(ENGINE_CLOCK) private readonly clock: SessionClockLike,
    @Inject(ENGINE_MASTER) private readonly master: InstrumentMasterLike,
    @Inject(ENGINE_QUOTES) private readonly quotes: QuotesLike,
    private readonly repo: EntryEngineRepository,
    private readonly signalRepo: SignalTraderRepository,
    private readonly oi: SignalOiCheckService,
    private readonly paper: EntryEnginePaperService,
    // 2026-11-04: the event calendar (market_events + MARKET_EVENT_DAYS) for the decision's reasons.
    // Optional: without it the decision simply carries no event line.
    @Optional() private readonly events?: MarketEventsRepository,
  ) {
    for (const p of cfg.problems) this.logger.warn(`[entry-engine] ${p}`);
  }

  @Cron('0 5-59/15 9-23 * * *', { name: 'entry-engine', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !bootJobsEnabled()) return;
    await this.run(new Date());
  }

  async run(now: Date): Promise<EvaluationResult[]> {
    if (this.cfg.mode === 'off') return [];
    if (this.running) return [];
    const m = istMinutes(now);
    if (m < ENGINE_WINDOW.fromMin || m > ENGINE_WINDOW.toMin) return [];
    this.running = true;
    const out: EvaluationResult[] = [];
    const pass: ScanPass = { clusterEntered: [] };
    try {
      for (const u of ENGINE_UNIVERSE) {
        try {
          out.push(await this.evaluate(u, now, pass));
        } catch (e) {
          this.logger.warn(`[entry-engine] ${u} evaluation failed: ${errText(e)}`);
          out.push({ underlying: u, decisionId: null, action: 'SKIPPED', opened: null, note: errText(e) });
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  /**
   * One underlying at `at`: read, decide, gate, record; open a paper trade when paper mode allows. `pass` is the scan
   * pass's shared state (the index-cluster cap); a lone call gets its own.
   */
  async evaluate(underlying: string, at: Date, pass: ScanPass = { clusterEntered: [] }): Promise<EvaluationResult> {
    const optionExchange = segmentFor({ underlying, instrumentKind: 'CE' });
    let open = false;
    try {
      open = this.clock.isOpen(optionExchange, at);
    } catch {
      open = false;
    }
    if (!open) return { underlying, decisionId: null, action: 'SKIPPED', opened: null, note: `${optionExchange} closed` };

    const sessionStart = sessionStartOf(optionExchange, at);
    const line = await this.lineOf(underlying, at);
    const from = new Date(at.getTime() - BAR_HISTORY_DAYS * 24 * 60 * MIN);
    // Impacts for the 60-min read AND the 3 h news theme; the day's pre-open outlook (08:30 IST).
    // Also back to IST midnight: strong stories are remembered for the day (newsReading).
    const sinceIstMidnightMin = Math.ceil(((at.getTime() + 330 * MIN) % (24 * 60 * MIN)) / MIN);
    const lookbackMin = Math.max(ENTRY_ENGINE.newsLookbackMin, NEWS_THEME.intraday.windowMin, sinceIstMidnightMin);
    const [impacts, hub, table, preOpen] = await Promise.all([
      this.repo.impacts(new Date(at.getTime() - lookbackMin * MIN), at),
      line ? this.repo.hubBars(line.exchange, line.token, from, at) : Promise.resolve([]),
      line ? this.repo.tableBars(line.exchange, line.token, from, at) : Promise.resolve([]),
      this.repo.preOpenOutlook(underlying, istYmdOf(at)).catch(() => null),
    ]);
    const news = withNewsPaths(newsReading(impacts, underlying, at), newsTheme(impacts, underlying, at, NEWS_THEME.intraday), preOpen, at);
    const chosen = chooseBars(hub, table, sessionStart, at);
    const trend = trendReading(chosen.bars, at, sessionStart);
    const want = wantFor(news, trend);
    const oi = await this.oiRead(underlying, optionExchange, want, trend.price, at);
    const event = await this.eventRead(underlying, at);
    const decision = entryDecision({ underlying, at, news, trend, oi, event, sessionStart });

    // ENTRY GATES (2026-11-11, domain/entry-gates.ts): 15m indicators + how far the price already ran. Read on every
    // evaluation (for the night review), for the decision's direction or else the direction OI was asked about.
    const gateDir: Direction = decision.direction ?? want;
    const readings = await this.gateReadings(line, chosen.bars, trend.price, gateDir, at);
    const gated = applyEntryGates(decision.action as 'ENTER_CE' | 'ENTER_PE' | 'NO_TRADE', readings, readings.unreadWhy ?? 'no bars');
    const action: EngineAction = gated.action;

    let minutesToClose: number | null = null;
    try {
      minutesToClose = this.clock.minutesToClose(optionExchange, at);
    } catch {
      minutesToClose = null;
    }
    const [openForUnderlying, tradesToday] = await Promise.all([this.repo.openEngineTrades(underlying), this.repo.engineTradesSince(istDayAt(at, 0))]);
    const base = entryGuards({ openForUnderlying, tradesToday, minutesToClose });
    // INDEX CLUSTER (correlated bet): only an ENTER on a cluster underlying asks.
    const cluster = isEnterAction(action) && inIndexCluster(underlying) ? await this.clusterRead(underlying, gateDir, pass) : null;
    const guards: GuardResult = cluster && cluster.verdict === 'BLOCK' ? { ok: false, reasons: [...base.reasons, gateLine('cluster', cluster)] } : base;
    const clusterReason = cluster && cluster.verdict !== 'BLOCK' ? [gateLine('cluster', cluster)] : [];

    const id = randomUUID();
    const reasons = [...decision.reasons, ...gated.reasons, ...clusterReason];
    await this.repo.insertDecision({
      id,
      underlying,
      at,
      action,
      mode: this.cfg.mode,
      // readiness marks a session-warm-up NO_TRADE so the night review does not grade it as a decision (detectInputMissing).
      inputs: {
        news,
        trend: { ...trend, barSource: chosen.source, line },
        oi,
        ...(event ? { event } : {}),
        ...(decision.inputNotReady ? { readiness: { status: INPUT_NOT_READY, missing: decision.inputNotReady } } : {}),
        guards: { openForUnderlying, tradesToday, minutesToClose, ok: guards.ok, ...(cluster ? { cluster: { verdict: cluster.verdict, read: cluster.compact } } : {}) },
        gates: {
          direction: gateDir,
          preGateAction: decision.action,
          indicators: readings.indicators,
          extension: readings.extension,
          verdicts: { indicators: gated.indicators.verdict, chase: gated.chase.verdict, cluster: cluster?.verdict ?? null },
          ...(readings.unreadWhy ? { unread: readings.unreadWhy } : {}),
        },
        scores: decision.scores,
      },
      reasons: [...reasons, ...guards.reasons],
    });
    this.logger.log(`[entry-engine] ${underlying} ${action} (${this.cfg.mode}) — ${reasons.map((r) => r.split(' — ')[0]).join('; ')}${guards.ok ? '' : `; ${guards.reasons.join('; ')}`}`);

    if (!isEnterAction(action)) return { underlying, decisionId: id, action, opened: null };
    if (this.cfg.mode !== 'paper') return { underlying, decisionId: id, action, opened: null, note: 'observe: nothing opened' };
    if (!guards.ok) {
      await this.repo.settleDecision(id, null, `paper: not opened — ${guards.reasons.join('; ')}`);
      return { underlying, decisionId: id, action, opened: null, note: guards.reasons.join('; ') };
    }
    const opened = await this.openPaper(id, underlying, decision, reasons, trend.price, at);
    if (opened.tradeId && inIndexCluster(underlying)) pass.clusterEntered.push(underlying.toUpperCase());
    await this.repo.settleDecision(id, opened.tradeId, opened.note);
    return { underlying, decisionId: id, action, opened: opened.tradeId, note: opened.note };
  }

  /**
   * The gates' readings: the line's completed 15m bars through the signal-trader's trend-bar loader (candles_1m →
   * 15m + the `candles` 15m history; DB only) and the 1m bars the trend read, both cut to the venue's session
   * (sessionBars). Never throws: a failed read is recorded and the gates read UNKNOWN (never block).
   */
  private async gateReadings(
    line: { exchange: string; token: string; symbol: string } | null,
    bars1m: readonly Bar1m[],
    price: number | null,
    direction: Direction,
    at: Date,
  ): Promise<{ indicators: IndicatorReading | null; extension: ExtensionReading | null; unreadWhy?: string }> {
    if (!line) return { indicators: null, extension: null, unreadWhy: 'no price line' };
    try {
      const { bars, source } = await loadTrendBars(this.signalRepo, line, at);
      const bars15 = sessionBars(bars, line.exchange);
      return {
        indicators: indicatorReading(bars15, direction, at, `${source}; session bars ${bars15.length}`),
        extension: extensionReading({ bars15, bars1m: sessionBars(bars1m, line.exchange), price, at, direction }),
      };
    } catch (e) {
      this.logger.warn(`[entry-engine] ${line.symbol} 15m bars for the entry gates failed (not blocking): ${errText(e)}`);
      return { indicators: null, extension: null, unreadWhy: `15m bars unreadable: ${errText(e)}` };
    }
  }

  /** The index-cluster cap's facts: open engine positions per direction in the cluster + this pass's cluster entries. */
  private async clusterRead(underlying: string, direction: Direction, pass: ScanPass): Promise<GateResult> {
    let open: { bullish: number; bearish: number } | null = null;
    try {
      open = await this.repo.openEngineByDirection(INDEX_CLUSTER);
    } catch (e) {
      this.logger.warn(`[entry-engine] cluster open-position read failed (blocks): ${errText(e)}`);
    }
    return clusterGate({ underlying, direction, openBullish: open?.bullish ?? null, openBearish: open?.bearish ?? null, enteredThisPass: pass.clusterEntered });
  }

  /** The underlying's own price line: the index, or an MCX underlying's nearest future. */
  private async lineOf(underlying: string, at: Date): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const index = INDEX_UNDERLYINGS[underlying.toUpperCase()];
    if (index) return { exchange: index.exchange, token: index.token, symbol: index.symbol };
    const fut = await this.signalRepo.nearestFuture(underlying, istDayAt(at, 0));
    return fut ? { exchange: fut.exchange, token: fut.token, symbol: fut.symbol } : null;
  }

  /**
   * The event view (2026-11-04, US-midterm GOLD day: the engine never knew it was an event day). Never
   * throws: eventContextFor reports an unreadable / empty calendar as absent(<reason>) itself; null only
   * when no calendar is wired here at all.
   */
  private async eventRead(underlying: string, at: Date): Promise<EventContext | null> {
    if (!this.events) return null;
    try {
      return await eventContextFor(underlying, at, { repo: this.events });
    } catch (e) {
      return { status: 'absent', reason: `event context failed: ${errText(e)}` };
    }
  }

  /** The OI read (signal-trader's DB-only input builder); the trend price centres the strikes when nothing else can. */
  private async oiRead(underlying: string, exchange: string, want: 'BULLISH' | 'BEARISH', price: number | null, at: Date): Promise<OiReading | null> {
    try {
      const input = await this.oi.input({
        decisionId: '',
        signal: { underlying, instrumentKind: want === 'BULLISH' ? 'CE' : 'PE', strike: null },
        plan: { exchange, side: 'BUY', ltp: 0 },
        expiry: null,
        at,
      });
      if (input.chain && !(input.chain.center !== null && input.chain.center > 0) && price !== null && price > 0) {
        input.chain = { ...input.chain, center: price, centerSource: 'entry-engine trend price (1m bars)' };
      }
      return readOi(input);
    } catch (e) {
      this.logger.warn(`[entry-engine] ${underlying} OI read failed (NO_DATA): ${errText(e)}`);
      return null;
    }
  }

  /** Contract → LTP → plan → paper open. Every refusal is a note on the decision row. */
  private async openPaper(decisionId: string, underlying: string, d: EntryDecision, reasons: readonly string[], spot: number | null, at: Date): Promise<{ tradeId: string | null; note: string }> {
    const kind = d.action === 'ENTER_CE' ? 'CE' : 'PE';
    const owner = this.signalCfg.ownerUserId;
    if (!owner) return { tradeId: null, note: 'paper: not opened — HUB_OWNER_USER_ID is not set (no quote session)' };
    let master: unknown[];
    try {
      master = await this.master.getInstrumentMaster();
    } catch (e) {
      return { tradeId: null, note: `paper: not opened — instrument master unavailable: ${errText(e)}` };
    }
    const cands = atmCandidates(master, underlying, kind, spot ?? 0, at);
    if (!cands.ok) return { tradeId: null, note: `paper: not opened — ${cands.reason}` };
    // LIQUIDITY (2026-11-05, engine-contract.ts ENGINE_LIQUIDITY): never a strike nobody is trading.
    let liq: Awaited<ReturnType<EntryEngineRepository['strikeLiquidity']>> | null = null;
    try {
      liq = await this.repo.strikeLiquidity(underlying, kind, cands.expiry, cands.strikes, sessionStartOf(segmentFor({ underlying, instrumentKind: kind }), at), new Date(at.getTime() - ENGINE_LIQUIDITY.recentMin * MIN));
    } catch (e) {
      this.logger.warn(`[entry-engine] liquidity read failed for ${underlying} ${kind}: ${errText(e)} — ATM, unchecked`);
    }
    const pick = pickLiquidStrike(cands.strikes, liq);
    if (!pick.ok) return { tradeId: null, note: `paper: not opened — ${pick.reason}` };
    const atm = { strike: pick.strike, expiry: cands.expiry };
    const contract = engineContract(master, { underlying, instrumentKind: kind, strike: atm.strike, expiry: atm.expiry }, at);
    if (!contract.ok) return { tradeId: null, note: `paper: not opened — ${contract.reason}` };
    const c = contract.contract;
    const ltp = await this.quotes.ltp(owner, c.token, c.exchange).catch(() => null);
    if (ltp === null || !(ltp > 0)) return { tradeId: null, note: `paper: not opened — no fresh LTP for ${c.tradingsymbol}` };
    const signal = engineSignal({ decisionId, underlying, kind, strike: atm.strike, expiry: c.expiry ?? atm.expiry, ltp, tick: c.tickSize, at });
    const planned = planEngineEntry({ signal, contract, ltp, cfg: this.signalCfg });
    if (!planned.plan) {
      const failed = planned.checks.filter((x) => x.required && x.ok !== true).map((x) => `${x.name}: ${x.detail}`);
      return { tradeId: null, note: `paper: not opened — plan refused (${failed.join('; ') || 'no plan'})` };
    }
    const r = await this.paper.open({ decisionId, plan: planned.plan, underlying, kind, strike: atm.strike, expiry: c.expiry ?? atm.expiry, why: reasons.map((x) => x.split(' — ')[0]).join('; ') });
    return r.ok
      ? { tradeId: r.tradeId, note: `paper: opened ${planned.plan.tradingsymbol} x${planned.plan.qty} @ ${r.entryPrice ?? ltp} (trade ${r.tradeId}); ${pick.note}` }
      : { tradeId: null, note: `paper: open failed — ${r.reason}` };
  }
}
