import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { INDEX_UNDERLYINGS } from '../market-hub/underlying';
import { segmentFor } from '../signal-trader/domain/contract-resolver';
import type { SignalTraderConfig } from '../signal-trader/domain/signal-trader.config';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';
import { SignalOiCheckService } from '../signal-trader/services/signal-oi-check.service';
import type { InstrumentMasterLike, QuotesLike, SessionClockLike } from '../signal-trader/services/signal-trader.service';
import { atmOption, engineContract, engineSignal, planEngineEntry } from './domain/engine-contract';
import { chooseBars, ENGINE_UNIVERSE, ENGINE_WINDOW, istDayAt, istMinutes, readOi, sessionStartOf, wantFor } from './domain/engine-inputs';
import { ENTRY_ENGINE, entryDecision, entryGuards, newsReading, trendReading, type EntryDecision, type GuardResult, type OiReading } from './domain/entry-decision';
import { ENTRY_ENGINE_CONFIG, type EntryEngineConfig } from './entry-engine.config';
import { EntryEnginePaperService } from './entry-engine-paper.service';
import { EntryEngineRepository } from './entry-engine.repository';

export const ENGINE_CLOCK = Symbol('ENGINE_CLOCK');
export const ENGINE_MASTER = Symbol('ENGINE_MASTER');
export const ENGINE_QUOTES = Symbol('ENGINE_QUOTES');
/** The signal-trader config the plan is built with (owner id, caps, tolerance). */
export const ENGINE_SIGNAL_CONFIG = Symbol('ENGINE_SIGNAL_CONFIG');

const MIN = 60_000;
/** History read for the 1h EMA (≥ 11 hourly closes: two NSE sessions, over a weekend). */
const BAR_HISTORY_DAYS = 6;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface EvaluationResult {
  underlying: string;
  decisionId: string | null;
  action: EntryDecision['action'] | 'SKIPPED';
  opened: string | null;
  note?: string;
}

/**
 * ENTRY ENGINE stage 1 — the intraday idea pass (owner 2026-10-30). Every 15 min (IST :05/:20/:35/:50,
 * 09:20–23:00, venue open), for each underlying of the fixed universe: the news read of the last 60
 * min (news_impacts — the same model read the 08:40 news-ideas batch ranks with; that batch is left
 * unchanged), the trend from 1-minute bars, and the OI check (signal-trader SignalOiCheckService, DB
 * reads only) → entryDecision (code, deterministic). EVERY evaluation is recorded in
 * entry_engine_decisions, NO_TRADE included.
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
    try {
      for (const u of ENGINE_UNIVERSE) {
        try {
          out.push(await this.evaluate(u, now));
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

  /** One underlying at `at`: read, decide, record; open a paper trade when paper mode allows. */
  async evaluate(underlying: string, at: Date): Promise<EvaluationResult> {
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
    const [impacts, hub, table] = await Promise.all([
      this.repo.impacts(new Date(at.getTime() - ENTRY_ENGINE.newsLookbackMin * MIN), at),
      line ? this.repo.hubBars(line.exchange, line.token, from, at) : Promise.resolve([]),
      line ? this.repo.tableBars(line.exchange, line.token, from, at) : Promise.resolve([]),
    ]);
    const news = newsReading(impacts, underlying, at);
    const chosen = chooseBars(hub, table, sessionStart, at);
    const trend = trendReading(chosen.bars, at, sessionStart);
    const want = wantFor(news, trend);
    const oi = await this.oiRead(underlying, optionExchange, want, trend.price, at);
    const decision = entryDecision({ underlying, at, news, trend, oi });

    let minutesToClose: number | null = null;
    try {
      minutesToClose = this.clock.minutesToClose(optionExchange, at);
    } catch {
      minutesToClose = null;
    }
    const [openForUnderlying, tradesToday] = await Promise.all([this.repo.openEngineTrades(underlying), this.repo.engineTradesSince(istDayAt(at, 0))]);
    const guards = entryGuards({ openForUnderlying, tradesToday, minutesToClose });

    const id = randomUUID();
    await this.repo.insertDecision({
      id,
      underlying,
      at,
      action: decision.action,
      mode: this.cfg.mode,
      inputs: { news, trend: { ...trend, barSource: chosen.source, line }, oi, guards: { openForUnderlying, tradesToday, minutesToClose, ok: guards.ok }, scores: decision.scores },
      reasons: [...decision.reasons, ...guards.reasons],
    });
    this.logger.log(`[entry-engine] ${underlying} ${decision.action} (${this.cfg.mode}) — ${decision.reasons.map((r) => r.split(' — ')[0]).join('; ')}${guards.ok ? '' : `; ${guards.reasons.join('; ')}`}`);

    if (decision.action === 'NO_TRADE') return { underlying, decisionId: id, action: decision.action, opened: null };
    if (this.cfg.mode !== 'paper') return { underlying, decisionId: id, action: decision.action, opened: null, note: 'observe: nothing opened' };
    if (!guards.ok) {
      await this.repo.settleDecision(id, null, `paper: not opened — ${guards.reasons.join('; ')}`);
      return { underlying, decisionId: id, action: decision.action, opened: null, note: guards.reasons.join('; ') };
    }
    const opened = await this.openPaper(id, underlying, decision, trend.price, at);
    await this.repo.settleDecision(id, opened.tradeId, opened.note);
    return { underlying, decisionId: id, action: decision.action, opened: opened.tradeId, note: opened.note };
  }

  /** The underlying's own price line: the index, or an MCX underlying's nearest future. */
  private async lineOf(underlying: string, at: Date): Promise<{ exchange: string; token: string; symbol: string } | null> {
    const index = INDEX_UNDERLYINGS[underlying.toUpperCase()];
    if (index) return { exchange: index.exchange, token: index.token, symbol: index.symbol };
    const fut = await this.signalRepo.nearestFuture(underlying, istDayAt(at, 0));
    return fut ? { exchange: fut.exchange, token: fut.token, symbol: fut.symbol } : null;
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
  private async openPaper(decisionId: string, underlying: string, d: EntryDecision, spot: number | null, at: Date): Promise<{ tradeId: string | null; note: string }> {
    const kind = d.action === 'ENTER_CE' ? 'CE' : 'PE';
    const owner = this.signalCfg.ownerUserId;
    if (!owner) return { tradeId: null, note: 'paper: not opened — HUB_OWNER_USER_ID is not set (no quote session)' };
    let master: unknown[];
    try {
      master = await this.master.getInstrumentMaster();
    } catch (e) {
      return { tradeId: null, note: `paper: not opened — instrument master unavailable: ${errText(e)}` };
    }
    const atm = atmOption(master, underlying, kind, spot ?? 0, at);
    if (!atm.ok) return { tradeId: null, note: `paper: not opened — ${atm.reason}` };
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
    const r = await this.paper.open({ decisionId, plan: planned.plan, underlying, kind, strike: atm.strike, expiry: c.expiry ?? atm.expiry, why: d.reasons.map((x) => x.split(' — ')[0]).join('; ') });
    return r.ok
      ? { tradeId: r.tradeId, note: `paper: opened ${planned.plan.tradingsymbol} x${planned.plan.qty} @ ${r.entryPrice ?? ltp} (trade ${r.tradeId})` }
      : { tradeId: null, note: `paper: open failed — ${r.reason}` };
  }
}
