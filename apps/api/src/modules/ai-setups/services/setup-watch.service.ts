import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { contractValueFactor } from '@td/shared';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { engineConfig, engineContract } from '../../entry-engine/domain/engine-contract';
import { EntryEnginePaperService } from '../../entry-engine/entry-engine-paper.service';
import { planEntry } from '../../signal-trader/domain/gate';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import type { SignalView } from '../../signal-trader/domain/signal.types';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { AI_SETUPS_CONFIG, type AiSetupsConfig } from '../ai-setups.config';
import { setupCeilingFor } from '../domain/setup-checks';
import type { SetupPlan } from '../domain/setup.types';
import { BAR_15M_MS, filledStep, pendingStep, premiumFloorSl, worstFillLevel, type Bar15m, type SetupWatchState } from '../domain/setup-watch';
import {
  AI_SETUP_SOURCE,
  AI_SETUP_STRATEGY,
  AI_SETUP_TAG,
  AiSetupsRepository,
  setupTag,
  type ActiveSetupRow,
  type SetupTradeRow,
} from '../repositories/ai-setups.repository';

/** An instrument the watch prices (the underlying's index / NSE cash line / MCX front future, or the option). */
export interface WatchRef {
  exchange: string;
  token: string;
  symbol: string;
}

/** The market reads the watch needs (setup-watch.market.ts; a fake in the spec). Never an order. */
export const SETUP_WATCH_MARKET = Symbol('SETUP_WATCH_MARKET');
export interface SetupWatchMarket {
  /** The underlying's priced line (null when the master has none). */
  underlyingRef(underlying: string, now: Date): Promise<WatchRef | null>;
  /** Fresh LTPs keyed EXCHANGE:token — the market hub's live price first, the rest in ONE quote batch; absent = no fresh price. */
  ltps(refs: readonly WatchRef[], now: Date): Promise<Map<string, number>>;
  /** The underlying's 15m bars (ts = bar start, ms) — the same 15m loader the setup packet reads. */
  bars15m(ref: WatchRef, from: Date, now: Date): Promise<Bar15m[]>;
  /** The Angel instrument master (the option contract is resolved from it, never from a token). */
  master(): Promise<readonly unknown[] | null>;
  isOpen(exchange: string, now: Date): boolean;
  minutesToClose(exchange: string, now: Date): number | null;
}

/** The ai_setups / trades reads and conditional writes the watch uses (AiSetupsRepository). */
export type SetupWatchStore = Pick<
  AiSetupsRepository,
  'activeSetups' | 'claimFill' | 'attachTrade' | 'failOpen' | 'expire' | 'saveWatch' | 'markExited' | 'setupTrade' | 'tradeForSetup'
>;

type PaperOpener = Pick<EntryEnginePaperService, 'open'>;
type TradeCloser = Pick<TradeExecutionService, 'closeTrade'>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: Pick<WatchRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;
/** Trade statuses still open (anything else was closed by someone). */
const OPEN_TRADE = new Set(['OPEN', 'PARTIALLY_FILLED', 'PENDING']);
/** 15m bars read for a BREAKOUT_TRIGGER: from the setup's creation back this far (bars before it are ignored). */
const BARS_BACK_MS = 2 * BAR_15M_MS;
/** A 15m read that has not yet returned the latest closed bar is retried after this long. */
const BARS_RETRY_MS = 60_000;

const isPlan = (v: unknown): v is SetupPlan & { watch?: SetupWatchState } => {
  const s = v as SetupPlan | null;
  return (
    !!s && typeof s === 'object' && !!s.instrument && (s.instrument.optionType === 'CE' || s.instrument.optionType === 'PE') &&
    Number.isFinite(s.instrument.strike) && typeof s.instrument.expiry === 'string' && !!s.entry && Number.isFinite(s.sl) &&
    Array.isArray(s.targets) && s.targets.length > 0 && s.targets.every((t) => Number.isFinite(t))
  );
};

/**
 * THE SETUP WATCH (plan 2026-11-25 Task 5): a PENDING ai_setups row waits on its UNDERLYING's price and, when the
 * entry condition is met, opens a PAPER option trade (1 lot, the setup's own strike / expiry) through the entry
 * engine's paper path; the FILLED trade is closed on the underlying's SL / targets / validUntil. Paper only: this
 * file builds no order — the open is EntryEnginePaperService (isPaper: true) and the close TradeExecutionService
 * .closeTrade on a trade checked to be a PAPER AI_SETUP trade.
 *
 * Every 5 s, the state is read from the DB (restart-safe) and every transition is a conditional updateMany on the
 * row's status: PENDING → FILLED is CLAIMED before the paper open (a second pass / instance cannot open twice);
 * a close is the Trade row's own OPEN check (closeTrade refuses a closed trade), then FILLED → EXITED.
 *
 * AI_SETUP is also in PAPER_WATCH_STRATEGIES, so the generic paper watch and the paper sentinel manage these trades
 * exactly as they would live (AI exits, intraday square-off) — the premium SL on the trade is only the catastrophe
 * floor (1 lot losing the class ceiling) and it has no premium target, so the paper watch never fights the setup's
 * underlying levels. A trade they close is seen here as closed elsewhere (EXITED with their reason).
 */
@Injectable()
export class SetupWatchService {
  private readonly logger = new Logger(SetupWatchService.name);
  private busy = false;
  /** BREAKOUT_TRIGGER: the last 15m read per setup (re-read once a new bar should have closed). */
  private readonly barCache = new Map<string, { at: number; bars: Bar15m[] }>();

  constructor(
    @Inject(AI_SETUPS_CONFIG) private readonly cfg: AiSetupsConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: SignalTraderConfig,
    @Inject(AiSetupsRepository) private readonly store: SetupWatchStore,
    @Inject(SETUP_WATCH_MARKET) private readonly market: SetupWatchMarket,
    @Inject(EntryEnginePaperService) private readonly paper: PaperOpener,
    @Inject(TradeExecutionService) private readonly exec: TradeCloser,
  ) {}

  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode !== 'paper' || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.pass(new Date());
    } catch (err) {
      this.logger.warn(`[ai-setup] watch pass failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** One pass over every PENDING / FILLED setup. Mode off ⇒ idle. Never throws per row. */
  async pass(now: Date): Promise<void> {
    if (this.cfg.mode !== 'paper') return;
    const rows = await this.store.activeSetups();
    if (rows.length === 0) {
      this.barCache.clear();
      return;
    }
    const refs = new Map<string, WatchRef | null>();
    for (const u of new Set(rows.map((r) => r.underlying))) {
      refs.set(u, await this.market.underlyingRef(u, now).catch(() => null));
    }
    const trades = new Map<string, SetupTradeRow | null>();
    for (const r of rows) {
      if (r.status === 'FILLED' && r.tradeId) trades.set(r.tradeId, await this.store.setupTrade(r.tradeId).catch(() => null));
    }
    // ONE price batch per pass: every underlying + every open setup option (for the exit price).
    const batch = new Map<string, WatchRef>();
    for (const ref of refs.values()) if (ref) batch.set(keyOf(ref), ref);
    for (const t of trades.values()) {
      if (t?.instrument && OPEN_TRADE.has(t.status)) batch.set(keyOf(t.instrument), t.instrument);
    }
    let ltps = new Map<string, number>();
    try {
      ltps = batch.size > 0 ? await this.market.ltps([...batch.values()], now) : ltps;
    } catch (err) {
      this.logger.warn(`[ai-setup] price batch failed: ${errText(err)} — this pass judges time rules only`);
    }
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.barCache.keys()) if (!live.has(id)) this.barCache.delete(id);
    for (const row of rows) {
      try {
        const uref = refs.get(row.underlying) ?? null;
        if (row.status === 'PENDING') await this.onPending(row, uref, ltps, now);
        else await this.onFilled(row, uref, row.tradeId ? (trades.get(row.tradeId) ?? null) : null, ltps, now);
      } catch (err) {
        this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: ${errText(err)}`);
      }
    }
  }

  // ---- PENDING ------------------------------------------------------------------------------------------------

  private async onPending(row: ActiveSetupRow, uref: WatchRef | null, ltps: Map<string, number>, now: Date): Promise<void> {
    if (!isPlan(row.setup)) {
      if (await this.store.expire(row.id, 'INVALID_SETUP: the stored setup has no readable instrument / entry / SL / targets', now)) {
        this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} EXPIRED: unreadable setup`);
      }
      return;
    }
    const setup = row.setup;
    // A closed market's last price is not a fill: only validUntil can act then.
    const open = !!uref && this.market.isOpen(uref.exchange, now);
    const ltp = open && uref ? (ltps.get(keyOf(uref)) ?? null) : null;
    const bars = open && uref && setup.entry.type === 'BREAKOUT_TRIGGER' ? await this.barsFor(row, uref, now) : null;
    const step = pendingStep({ setup, ltp, now, validUntil: row.validUntil, createdAt: row.createdAt, bars15m: bars });
    if (step.action === 'WAIT') return;
    if (step.action === 'EXPIRE') {
      if (await this.store.expire(row.id, step.reason, now)) this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} EXPIRED — ${step.reason}`);
      return;
    }
    // FILL: claim first (PENDING → FILLED), so no other pass / instance opens it too.
    if (!(await this.store.claimFill(row.id, now))) return;
    const opened = await this.openPaper(row, setup, ltp as number, now);
    if (!opened.ok) {
      const reason = `OPEN_FAILED: ${opened.reason}`;
      await this.store.failOpen(row.id, reason, now);
      this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} not opened — ${reason}`);
      return;
    }
    const watch: SetupWatchState = { sl: setup.sl, trailed: false, worstFill: worstFillLevel(setup, ltp as number), entryUnderlying: ltp, entryPremium: opened.entryPremium };
    if (!(await this.store.attachTrade(row.id, opened.tradeId, { ...setup, watch }))) {
      this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: paper trade ${opened.tradeId} opened but the row moved — the next pass re-attaches it by its tag`);
      return;
    }
    this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} FILLED — ${step.reason}; paper ${opened.symbol} @ ${opened.entryPremium ?? '?'} (trade ${opened.tradeId})`);
  }

  /** Closed 15m bars since the setup, re-read only once a newer bar should have closed (and retried until it has). */
  private async barsFor(row: ActiveSetupRow, uref: WatchRef, now: Date): Promise<Bar15m[] | null> {
    const latestClosedStart = Math.floor(now.getTime() / BAR_15M_MS) * BAR_15M_MS - BAR_15M_MS;
    const c = this.barCache.get(row.id);
    const has = c?.bars.some((b) => b.ts >= latestClosedStart) ?? false;
    if (c && (has || now.getTime() - c.at < BARS_RETRY_MS) && Math.floor(c.at / BAR_15M_MS) === Math.floor(now.getTime() / BAR_15M_MS)) return c.bars;
    try {
      const bars = await this.market.bars15m(uref, new Date(row.createdAt.getTime() - BARS_BACK_MS), now);
      this.barCache.set(row.id, { at: now.getTime(), bars: bars ?? [] });
      return bars ?? [];
    } catch (err) {
      this.logger.warn(`[ai-setup] ${row.underlying} 15m bars: ${errText(err)}`);
      return c?.bars ?? null;
    }
  }

  /**
   * The paper option trade: the setup's own contract (resolved from the master by name / expiry / strike / type),
   * its fresh premium, and signal-trader's planEntry for a synthetic "BUY it AT the premium" with the catastrophe
   * floor as the premium SL and no premium target; 1 lot. Paper only (EntryEnginePaperService).
   */
  private async openPaper(
    row: ActiveSetupRow,
    s: SetupPlan,
    uLtp: number,
    now: Date,
  ): Promise<{ ok: true; tradeId: string; entryPremium: number | null; symbol: string } | { ok: false; reason: string }> {
    const fail = (reason: string) => ({ ok: false as const, reason });
    const u = row.underlying.toUpperCase();
    const kind = s.instrument.optionType;
    const master = await this.market.master().catch(() => null);
    if (!master || master.length === 0) return fail('instrument master unavailable');
    const contract = engineContract(master, { underlying: u, instrumentKind: kind, strike: s.instrument.strike, expiry: s.instrument.expiry }, now);
    if (!contract.ok) return fail(contract.reason);
    const c = contract.contract;
    const oref: WatchRef = { exchange: c.exchange, token: c.token, symbol: c.tradingsymbol };
    const px = (await this.market.ltps([oref], now).catch(() => new Map<string, number>())).get(keyOf(oref)) ?? null;
    if (px === null || !(px > 0)) return fail(`no fresh LTP for ${c.tradingsymbol}`);
    const ceiling = setupCeilingFor(u, c.exchange);
    const sl = premiumFloorSl({ ltp: px, ceiling, qty: c.lotSize, valueFactor: contractValueFactor(c.exchange, c.tradingsymbol), tick: c.tickSize });
    const expiry = c.expiry ?? s.instrument.expiry;
    const signal: SignalView = {
      id: row.id,
      channelId: null,
      receivedAt: now,
      underlying: u,
      instrumentKind: kind,
      strike: s.instrument.strike,
      expiry,
      side: 'BUY',
      entryLow: px,
      entryHigh: px,
      entryType: 'AT',
      sl,
      targets: [],
      qty: 1,
      confidence: null,
      rawText: `ai-setup ${u} ${s.instrument.strike} ${kind} ${expiry}`,
      horizon: 'INTRADAY',
    };
    const planned = planEntry({ signal, contract, ltp: px, engineSl: null, engineSlInfo: null, engineTargets: null }, engineConfig(this.traderCfg));
    if (!planned.plan) {
      const failed = planned.checks.filter((x) => x.required && x.ok !== true).map((x) => `${x.name}: ${x.detail}`);
      return fail(`plan refused (${failed.join('; ') || 'no plan'})`);
    }
    const why =
      `underlying ${uLtp}: ${s.entry.type} ${s.entry.low}–${s.entry.high}${s.entry.trigger !== null ? ` trigger ${s.entry.trigger}` : ''}, ` +
      `underlying SL ${s.sl}, targets ${s.targets.join(' / ')}, valid until ${s.validUntil} IST; premium SL ${sl} = catastrophe floor (₹${ceiling} for 1 lot)`;
    const r = await this.paper.open({
      decisionId: row.id,
      plan: planned.plan,
      underlying: u,
      kind,
      strike: s.instrument.strike,
      expiry,
      why,
      brand: { strategy: AI_SETUP_STRATEGY, source: AI_SETUP_SOURCE, tags: [AI_SETUP_TAG, setupTag(row.id)], label: 'AI setup' },
    });
    return r.ok ? { ok: true, tradeId: r.tradeId, entryPremium: r.entryPrice ?? px, symbol: c.tradingsymbol } : fail(r.reason);
  }

  // ---- FILLED -------------------------------------------------------------------------------------------------

  private async onFilled(row: ActiveSetupRow, uref: WatchRef | null, trade: SetupTradeRow | null, ltps: Map<string, number>, now: Date): Promise<void> {
    if (!row.tradeId) return this.recoverClaim(row, now);
    if (!trade) {
      if (await this.store.markExited(row.id, { exitReason: 'TRADE_MISSING: the paper trade row is gone', exitAt: now, pnl: null })) {
        this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: trade ${row.tradeId} missing — EXITED`);
      }
      return;
    }
    if (!OPEN_TRADE.has(trade.status)) {
      // Closed by someone else (paper sentinel AI exit, the paper watch's floor / square-off, the kill switch) — or by
      // this watch on a pass whose row update failed: either way the Trade row says why.
      const reason = trade.exitReasonTag ?? `CLOSED_ELSEWHERE (${trade.status})`;
      if (await this.store.markExited(row.id, { exitReason: reason, exitAt: trade.exitTime ?? now, pnl: trade.pnl ?? null })) {
        this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} EXITED — trade ${trade.id} closed elsewhere: ${reason}, P&L ${trade.pnl ?? '?'}`);
      }
      return;
    }
    if (!isPlan(row.setup)) {
      this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: unreadable setup — left to the paper watch`);
      return;
    }
    const setup = row.setup;
    // A row attached without a watch (should not happen): the setup's own SL; MARKET_NOW's fill unknown → its expected fill.
    const watch: SetupWatchState = setup.watch ?? { sl: setup.sl, trailed: false, worstFill: worstFillLevel(setup, setup.entry.high) };
    const exchange = trade.instrument?.exchange ?? uref?.exchange ?? 'NSE';
    const open = this.market.isOpen(exchange, now);
    const uLtp = open && uref ? (ltps.get(keyOf(uref)) ?? null) : null;
    const step = filledStep({ setup, watch, ltp: uLtp, now, validUntil: row.validUntil, minutesToClose: open ? this.market.minutesToClose(exchange, now) : null });
    if (step.action === 'HOLD') return;
    if (step.action === 'TRAIL') {
      const next: SetupWatchState = { ...watch, sl: step.sl, trailed: true, trailedAt: now.toISOString() };
      if (await this.store.saveWatch(row.id, { ...setup, watch: next })) this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} trailed — ${step.reason}`);
      return;
    }
    if (!trade.isPaperTrade || trade.strategy !== AI_SETUP_STRATEGY) {
      // Never a real-money close from here (closeTrade would route a live trade to the broker).
      this.logger.error(`[ai-setup] ${row.underlying} setup ${row.id}: trade ${trade.id} is not a PAPER ${AI_SETUP_STRATEGY} trade — not closed (${step.tag})`);
      return;
    }
    const optPx = trade.instrument ? (ltps.get(keyOf(trade.instrument)) ?? null) : null;
    let closed: { pnl?: number | null } | null = null;
    try {
      closed = (await this.exec.closeTrade(trade.id, {
        exitReasonTag: step.tag,
        reason: `AI setup ${step.tag}: ${step.reason}`,
        exitNotes: `AI setup ${row.id}: ${step.reason}${optPx === null ? ' (no fresh option tick: the paper close prices it)' : ''}`.slice(0, 2000),
        ...(optPx !== null && optPx > 0 ? { exitPrice: optPx } : {}),
      })) as { pnl?: number | null };
    } catch (err) {
      // Closed meanwhile (closeTrade refuses a non-OPEN trade): the next pass reads who closed it.
      this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: close ${step.tag} failed: ${errText(err)}`);
      return;
    }
    await this.store.markExited(row.id, { exitReason: step.tag, exitAt: now, pnl: closed?.pnl ?? null });
    this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} EXITED ${step.tag} — ${step.reason}; option ${optPx ?? 'unpriced'}, P&L ${closed?.pnl ?? '?'}`);
  }

  /**
   * A FILLED row with no trade: the process stopped between the claim and the attach. The paper trade carries the
   * setup's tag, so it is re-attached; none ⇒ nothing was opened ⇒ EXPIRED (visible, never stuck).
   */
  private async recoverClaim(row: ActiveSetupRow, now: Date): Promise<void> {
    const t = await this.store.tradeForSetup(row.id);
    if (!t) {
      if (await this.store.failOpen(row.id, `OPEN_INTERRUPTED: no paper trade carries ${setupTag(row.id)} (stopped between the claim and the open)`, now)) {
        this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id} EXPIRED — claimed but never opened`);
      }
      return;
    }
    const setup = isPlan(row.setup) ? row.setup : null;
    const watch: SetupWatchState | undefined = setup
      ? setup.watch ?? { sl: setup.sl, trailed: false, worstFill: worstFillLevel(setup, setup.entry.high), entryUnderlying: null, entryPremium: t.entryPrice }
      : undefined;
    if (await this.store.attachTrade(row.id, t.id, setup ? { ...setup, watch } : row.setup)) {
      this.logger.warn(`[ai-setup] ${row.underlying} setup ${row.id}: re-attached paper trade ${t.id} after a restart`);
    }
  }
}
