import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { contractValueFactor } from '@td/shared';
import { engineContract } from '../../entry-engine/domain/engine-contract';
import { EntryEnginePaperService } from '../../entry-engine/entry-engine-paper.service';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { slEnforceability } from '../../signal-trader/domain/execution';
import { marginPosition, parseMarginResponse, type BrokerMargin } from '../../signal-trader/domain/funds';
import { planEntry } from '../../signal-trader/domain/gate';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import type { SignalView } from '../../signal-trader/domain/signal.types';
import { preSendChecks } from '../../signal-trader/services/pre-send-checks';
import { SignalExecutorService } from '../../signal-trader/services/signal-executor.service';
import { SIGNAL_FUNDS, SIGNAL_QUOTES, SIGNAL_TRADER_CONFIG, type FundsLike, type QuotesLike } from '../../signal-trader/services/signal-trader.service';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import type { ActionContext, ActionResult, DeskActionsPort, DeskMode, DeskPacket, ManagerDecision } from '../domain/desk.types';
import { ceilingFor, estimatePremiumLoss, estimateSpread, pickContractSpec, premiumStop } from '../domain/premium-risk';
import { DeskActionsRepository, type PendingEntryRow } from '../repositories/desk-actions.repository';
import {
  DESK_ACTIONS_ENV,
  DESK_EXIT_ACTIONS,
  DESK_MARKET,
  DESK_OPEN_GUARD,
  DESK_OPTION_DELTA,
  DESK_RUNNER_HEALTH,
  type DeskExitActionsPort,
  type DeskGuardPort,
  type DeskMarket,
  type DeskOptionDelta,
  type DeskRef,
  type DeskRunnerHealth,
} from './desk-actions.ports';

export type OpenDecision = Extract<ManagerDecision, { action: 'OPEN' }>;

/** The paper brand of a manager OPEN in shadow mode. */
export const DESK_MANAGER_STRATEGY = 'DESK_MANAGER';
export const DESK_MANAGER_SOURCE = 'desk-manager';
export const DESK_MANAGER_TAG = 'desk-manager';
export const deskDecisionTag = (decisionId: string) => `desk-decision:${decisionId}`;

/** What a FILLED pending-entry row carries until its stop is armed (the pending-entry pass arms it). */
export interface EntryStopState {
  underlying: number;
  state: 'WAITING' | 'ARMED' | 'NO_FILL' | 'FAILED';
  detail?: string;
  ref?: string;
}

type Store = Pick<DeskActionsRepository, 'entriesToday' | 'busyUnderlyings' | 'insertPending' | 'move'>;
type Placer = Pick<SignalExecutorService, 'place'>;
type PaperOpener = Pick<EntryEnginePaperService, 'open'>;
type Env = Record<string, string | undefined>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const keyOf = (r: Pick<DeskRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;
const istMinutes = (at: Date) => Math.floor((at.getTime() / 60_000 + 330) % 1440);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const kindOf = (side: OpenDecision['side']): 'CE' | 'PE' | 'FUT' => (side === 'BUY_CE' ? 'CE' : side === 'BUY_PE' ? 'PE' : 'FUT');

/** The packet a pending-entry pass acts with (no manager run is in progress): every block unavailable. */
export function watchPacket(now: Date, mode: DeskMode): DeskPacket {
  const none = { status: 'unavailable' as const, reason: 'pending-entry watch: no manager packet', source: 'pending-entry-watch' };
  return { at: now.toISOString(), mode, day: none, pnl: none, guard: none, positions: none, recentExits: none, proposals: none, instruments: none, health: none, memory: none };
}

/** AI_AUTO_EXIT_HOLD as the sentinel-executor parses it (symbols / tracker ids, upper-case). */
function holdList(env: Env): string[] {
  return String(env.AI_AUTO_EXIT_HOLD ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** A hold-list entry names this underlying: the name itself, or a contract symbol that starts with it and a digit. */
function holdNames(hold: readonly string[], underlying: string): string | null {
  const u = up(underlying);
  for (const h of hold) {
    if (h === u) return h;
    if (h.startsWith(u) && /\d/.test(h.charAt(u.length))) return h;
  }
  return null;
}

/**
 * THE MANAGER'S ACTIONS (desk spec §5.4; plan Task 5). OPEN is decided here end to end; EXIT / BOOK / TIGHTEN go
 * to the exit actions (Task 7); PAUSE / RESUME to the desk guard (live) or are only recorded (shadow).
 *
 * OPEN, in order: refusal checks (mode, health, owner, guard, HOLD list, venue window, day cap, one position per
 * underlying from ANY source) → the contract from the strike / expiry policy → the 1-lot premium loss at the
 * underlying stop against the class ceiling (above it = refused, never shrunk) → the premium stop → planEntry.
 * NOW acts at once; ZONE / BREAKOUT become a PENDING row the pending-entry watch fires (re-running every check).
 * live: SL enforceability + the shared pre-send checks (no mini swap) → SignalExecutorService.place with source
 * 'manager'; any refusal is recorded, never paper-traded. shadow: the entry engine's paper path, brand DESK_MANAGER.
 * The stop on the underlying is armed after the fill by the pending-entry pass (DeskExitActions.tighten).
 */
@Injectable()
export class DeskActionsService implements DeskActionsPort {
  private readonly logger = new Logger(DeskActionsService.name);
  private readonly env: Env;

  constructor(
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: SignalTraderConfig,
    @Inject(DeskActionsRepository) private readonly store: Store,
    @Inject(DESK_MARKET) private readonly market: DeskMarket,
    @Inject(SignalExecutorService) private readonly executor: Placer,
    @Inject(EntryEnginePaperService) private readonly paper: PaperOpener,
    @Inject(SIGNAL_QUOTES) private readonly quotes: QuotesLike,
    @Optional() @Inject(SIGNAL_FUNDS) private readonly funds?: FundsLike,
    @Optional() @Inject(DESK_OPEN_GUARD) private readonly guard?: DeskGuardPort,
    @Optional() @Inject(DESK_EXIT_ACTIONS) private readonly exits?: DeskExitActionsPort,
    @Optional() @Inject(DESK_OPTION_DELTA) private readonly deltas?: DeskOptionDelta,
    // Typed as the class (not a Pick) so Nest's emitted metadata resolves it.
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() @Inject(DESK_ACTIONS_ENV) env?: Env,
  ) {
    this.env = env ?? process.env;
  }

  async execute(d: ManagerDecision, ctx: ActionContext): Promise<ActionResult> {
    const mode = ctx.cfg.mode;
    try {
      switch (d.action) {
        case 'OPEN':
          return await this.open(d, ctx);
        case 'EXIT':
        case 'BOOK':
          if (mode === 'off') return refused('mode off');
          if (!this.exits) return failed('exit actions not wired');
          return await this.exits.exit(d.trackerId, d.action, d.reason, ctx);
        case 'TIGHTEN':
          if (mode === 'off') return refused('mode off');
          if (!this.exits) return failed('exit actions not wired');
          return await this.exits.tighten(d.trackerId, d.underlyingStop, d.reason, ctx);
        case 'PAUSE_ENTRIES':
        case 'RESUME':
          return await this.pauseOrResume(d, ctx);
        default:
          return { status: 'RECORDED', detail: `${d.action} recorded` };
      }
    } catch (err) {
      this.logger.warn(`[desk-manager] ${d.action} (decision ${ctx.decisionId}) failed: ${errText(err)}`);
      return failed(errText(err).slice(0, 300));
    }
  }

  private async pauseOrResume(d: Extract<ManagerDecision, { action: 'PAUSE_ENTRIES' | 'RESUME' }>, ctx: ActionContext): Promise<ActionResult> {
    const mode = ctx.cfg.mode;
    if (mode === 'off') return refused('mode off');
    const what = d.action === 'PAUSE_ENTRIES' ? `pause ${d.scope} for ${d.minutes} min` : 'resume entries';
    if (mode !== 'live') return { status: 'RECORDED', detail: `shadow: ${what} recorded only` };
    const owner = ctx.cfg.ownerUserId;
    if (!owner) return refused('no owner (HUB_OWNER_USER_ID)');
    if (!this.guard) return failed('desk guard not wired');
    if (d.action === 'PAUSE_ENTRIES') await this.guard.pause(owner, d.scope, d.minutes, ctx.now);
    else await this.guard.resume(owner, ctx.now);
    return { status: 'DONE', detail: what };
  }

  // ---- OPEN ----------------------------------------------------------------------------------------------------

  private async open(d: OpenDecision, ctx: ActionContext): Promise<ActionResult> {
    const mode = ctx.cfg.mode;
    const refusal = await this.openRefusal(d, mode, ctx.cfg, ctx.now);
    if (refusal) return refused(refusal);
    const shape = entryShapeProblem(d);
    if (shape) return refused(shape);
    const owner = ctx.cfg.ownerUserId as string;
    const decision = { ...d, runId: ctx.runId };

    if (d.entry.type !== 'NOW') {
      const validUntil = new Date(ctx.now.getTime() + d.entry.validMin * 60_000);
      const id = await this.store.insertPending({ decisionId: ctx.decisionId, userId: owner, underlying: d.underlying, mode, decision, validUntil, status: 'PENDING' });
      if (!id) return refused('this decision already has an entry');
      return { status: 'PENDING', detail: `${describeEntry(d)} — watched until ${validUntil.toISOString()}`, ref: id };
    }

    const id = await this.store.insertPending({ decisionId: ctx.decisionId, userId: owner, underlying: d.underlying, mode, decision, validUntil: ctx.now, status: 'FILLED', result: { stage: 'acting' } });
    if (!id) return refused('this decision already has an entry');
    return this.actAndSettle(id, d, ctx.decisionId, mode, ctx.cfg, ctx.now);
  }

  /**
   * A PENDING row whose condition was met and that the caller has CLAIMED (PENDING → FILLED): re-run every OPEN
   * refusal check (this row excluded), then act. The row ends FILLED (acted), REFUSED or FAILED.
   */
  async fire(row: PendingEntryRow, now: Date): Promise<ActionResult> {
    const d = row.decision as OpenDecision;
    const mode = this.cfg.mode;
    const refusal = await this.openRefusal(d, mode, this.cfg, now, row.decisionId);
    if (refusal) {
      const r = refused(`at fire time: ${refusal}`);
      await this.store.move(row.id, 'FILLED', 'REFUSED', { result: r });
      return r;
    }
    return this.actAndSettle(row.id, d, row.decisionId, mode, this.cfg, now);
  }

  /**
   * Every OPEN refusal check (the plan's list), null = none applies. `excludeDecisionId`: a pending entry being
   * fired does not count against itself (day cap, one per underlying).
   */
  async openRefusal(d: OpenDecision, mode: DeskMode, cfg: DeskManagerConfig, now: Date, excludeDecisionId?: string): Promise<string | null> {
    if (mode === 'off') return 'mode off';
    if (this.opensBlocked()) return 'manager health: opens blocked (no completed run recently)';
    const owner = cfg.ownerUserId;
    if (!owner) return 'no owner (HUB_OWNER_USER_ID)';
    const u = up(d.underlying);
    if (!u) return 'no underlying';
    if (mode === 'shadow' && d.side === 'BUY_FUT') return 'shadow: the paper path trades options only (BUY_FUT refused)';
    const held = holdNames(holdList(this.env), u);
    if (held) return `${u} is on the owner's hold list (AI_AUTO_EXIT_HOLD ${held})`;

    const exchange = segmentFor({ underlying: u, instrumentKind: kindOf(d.side) });
    if (!this.market.isOpen(exchange, now)) return `${exchange} is closed`;
    const toClose = this.market.minutesToClose(exchange, now);
    if (toClose === null) return `${exchange} close time unknown`;
    if (toClose <= cfg.noEntryLastMin) return `${toClose} min to the ${exchange} close — no entries in the last ${cfg.noEntryLastMin} min`;
    if (exchange === 'NFO' || exchange === 'BFO') {
      const at = istMinutes(now);
      if (at < this.traderCfg.liveFromIstMin) return `${hhmm(at)} IST is before SIGNAL_LIVE_FROM_IST ${hhmm(this.traderCfg.liveFromIstMin)}`;
    }

    if (mode === 'live') {
      if (!this.guard) return 'desk guard not wired';
      const g = await this.guard.check(owner, 'manager', u, now);
      if (g.blocked) return `desk guard: ${g.reasons.join('; ') || 'blocked'}`;
    }
    const n = await this.store.entriesToday(owner, now, excludeDecisionId);
    if (n >= cfg.maxEntries) return `${n} manager entries today ≥ DESK_MANAGER_MAX_ENTRIES ${cfg.maxEntries}`;
    const busy = await this.store.busyUnderlyings(owner, now, excludeDecisionId);
    const what = busy.get(u);
    if (what) return `${u} already has ${what}`;
    return null;
  }

  private opensBlocked(): boolean {
    let h: DeskRunnerHealth | null = null;
    try {
      h = (this.moduleRef?.get(DESK_RUNNER_HEALTH, { strict: false }) as DeskRunnerHealth | undefined) ?? null;
    } catch {
      h = null;
    }
    try {
      return h?.opensBlocked() === true;
    } catch {
      return true;
    }
  }

  /** Act on an OPEN whose row is FILLED (claimed); settle the row from the outcome. Never throws. */
  private async actAndSettle(rowId: string, d: OpenDecision, decisionId: string, mode: DeskMode, cfg: DeskManagerConfig, now: Date): Promise<ActionResult> {
    let out: Acted;
    try {
      out = await this.act(d, decisionId, mode, cfg, now);
    } catch (err) {
      out = { result: failed(`OPEN failed: ${errText(err).slice(0, 300)}`), keepFilled: false };
    }
    try {
      if (out.keepFilled) {
        await this.store.move(rowId, 'FILLED', 'FILLED', { result: { ...out.result, entry: out.entry, stop: out.stop }, orderRowId: out.orderRowId ?? null, tradeId: out.tradeId ?? null });
      } else {
        await this.store.move(rowId, 'FILLED', out.result.status === 'FAILED' ? 'FAILED' : 'REFUSED', { result: { ...out.result, ...(out.entry ? { entry: out.entry } : {}) } });
      }
    } catch (err) {
      this.logger.error(`[desk-manager] entry row ${rowId} not settled (${out.result.status}): ${errText(err)}`);
    }
    return out.result;
  }

  private async act(d: OpenDecision, decisionId: string, mode: DeskMode, cfg: DeskManagerConfig, now: Date): Promise<Acted> {
    const no = (detail: string): Acted => ({ result: refused(detail), keepFilled: false });
    const u = up(d.underlying);
    const kind = kindOf(d.side);
    const owner = cfg.ownerUserId as string;

    const master = await this.market.master().catch(() => null);
    if (!master || master.length === 0) return { result: failed('instrument master unavailable'), keepFilled: false };
    let uref: DeskRef | null;
    try {
      uref = await this.market.underlyingRef(u, now);
    } catch (err) {
      return { result: failed(`underlying line unavailable: ${errText(err)}`), keepFilled: false };
    }
    if (!uref) return no(`no priced line for ${u}`);
    const spot = (await this.market.ltps([uref], now).catch(() => new Map<string, number>())).get(keyOf(uref)) ?? null;
    if (spot === null || !(spot > 0)) return no(`no fresh price for ${u}`);
    const stop = d.stop.underlying;
    const stopOk = d.side === 'BUY_PE' ? stop > spot : stop < spot;
    if (!finite(stop) || !stopOk) return no(`underlying ${spot} already past the stop ${stop}`);

    const spec = pickContractSpec(master, { underlying: u, side: d.side, strikePolicy: d.strikePolicy, expiryPolicy: d.expiryPolicy, spot }, now);
    if (!spec.ok) return no(spec.reason);
    const contract = engineContract(master, { underlying: u, instrumentKind: kind, strike: spec.strike, expiry: spec.expiry }, now);
    if (!contract.ok) return no(contract.reason);
    const c = contract.contract;
    if (holdList(this.env).includes(up(c.tradingsymbol))) return no(`${c.tradingsymbol} is on the owner's hold list`);
    const cref: DeskRef = { exchange: c.exchange, token: c.token, symbol: c.tradingsymbol };
    const premium = (await this.market.ltps([cref], now).catch(() => new Map<string, number>())).get(keyOf(cref)) ?? null;
    if (premium === null || !(premium > 0)) return no(`no fresh price for ${c.tradingsymbol}`);

    const vf = contractValueFactor(c.exchange, c.tradingsymbol);
    const delta = kind === 'FUT' || !this.deltas ? null : await this.deltas.delta({ exchange: c.exchange, token: c.token, tradingsymbol: c.tradingsymbol, underlying: u }, now).catch(() => null);
    const spread = estimateSpread(premium, c.tickSize);
    const loss = estimatePremiumLoss({ side: d.side, strikePolicy: d.strikePolicy, underlyingEntry: spot, underlyingStop: stop, lotQty: c.lotSize, valueFactor: vf, delta, spread });
    const ceiling = ceilingFor(u, c.exchange, c.tradingsymbol, cfg);
    if (!(ceiling > 0)) return no(`${c.tradingsymbol}: no class ceiling — manager OPENs need one`);
    if (loss > ceiling) return no(`estimated 1-lot loss ₹${loss} at the stop ${stop} > the ₹${ceiling} class ceiling (refused, never shrunk)`);
    const sl = premiumStop({ entryPremium: premium, loss, lotQty: c.lotSize, valueFactor: vf, tick: c.tickSize });
    const entry = { contract: c.tradingsymbol, exchange: c.exchange, token: c.token, premium, premiumSl: sl, spot, estLoss: loss, ceiling, delta, spread, valueFactor: vf };

    const expiry = c.expiry ?? spec.expiry;
    const signal: SignalView = {
      id: decisionId,
      channelId: null,
      receivedAt: now,
      underlying: u,
      instrumentKind: kind,
      strike: spec.strike,
      expiry,
      side: 'BUY',
      entryLow: premium,
      entryHigh: premium,
      entryType: 'AT',
      sl,
      targets: [],
      qty: 1,
      confidence: null,
      rawText: `desk-manager ${d.side} ${u} ${spec.strike ?? ''} ${expiry}`.replace(/\s+/g, ' ').trim(),
      horizon: 'INTRADAY',
    };
    const planCfg: SignalTraderConfig = { ...this.traderCfg, mode: mode === 'live' ? 'live' : 'paper', paperLearn: false, maxLots: 1, defaultLots: 1, maxLossPerTrade: ceiling };
    const planned = planEntry({ signal, contract, ltp: premium, engineSl: null, engineSlInfo: null, engineTargets: null }, planCfg, this.env);
    if (!planned.plan) {
      const why = planned.checks.filter((x) => x.required && x.ok !== true).map((x) => `${x.name}: ${x.detail}`);
      return { result: refused(`plan refused (${why.join('; ') || 'no plan'})`), keepFilled: false, entry };
    }
    const plan = planned.plan;
    const stopState: EntryStopState = { underlying: stop, state: 'WAITING' };
    const what = `${d.side} ${c.tradingsymbol} 1 lot @ ${premium} (underlying ${spot}, stop ${stop}, est. loss ₹${loss} ≤ ₹${ceiling}, premium SL ${sl})`;

    if (mode !== 'live') {
      if (kind === 'FUT') return { result: refused('shadow: the paper path trades options only (BUY_FUT refused)'), keepFilled: false, entry };
      const r = await this.paper.open({
        decisionId,
        plan,
        underlying: u,
        kind,
        strike: spec.strike as number,
        expiry,
        why: `${d.reason}. Underlying stop ${stop}, targets ${d.targets.underlying.join(' / ') || '—'}; est. 1-lot loss ₹${loss} (ceiling ₹${ceiling}).`,
        brand: { strategy: DESK_MANAGER_STRATEGY, source: DESK_MANAGER_SOURCE, tags: [DESK_MANAGER_TAG, deskDecisionTag(decisionId)], label: 'Desk manager' },
      });
      if (!r.ok) return { result: failed(`paper open failed: ${r.reason}`), keepFilled: false, entry };
      return { result: { status: 'DONE', detail: `shadow paper ${what}`, ref: r.tradeId }, keepFilled: true, entry, stop: stopState, tradeId: r.tradeId };
    }

    // ---- live ----
    const enf = slEnforceability(this.env, owner, c.exchange, c.tradingsymbol);
    if (!enf.ok) return { result: refused(`stop not enforceable: ${enf.detail}`), keepFilled: false, entry };
    const pre = await preSendChecks({
      plan,
      signal,
      cfg: this.traderCfg,
      quote: () => this.quotes.ltp(owner, plan.token, plan.exchange),
      margin: (p) => this.brokerMargin(owner, p, enf.qtyUnit),
      available: () => this.readFunds(owner),
      mini: false,
    });
    if (pre.stage === 'price') return { result: refused(`pre_send_price: ${pre.recheck.detail}`), keepFilled: false, entry };
    if (!pre.ok) return { result: refused(`funds: ${pre.funds.detail}`), keepFilled: false, entry };
    const placed = await this.executor.place({
      decisionId,
      ownerUserId: owner,
      plan: pre.plan,
      product: this.traderCfg.product,
      qtyUnit: enf.qtyUnit,
      channel: 'desk-manager',
      signalSummary: `desk manager ${what}`,
      fillWaitSec: this.traderCfg.fillWaitSec,
      source: 'manager',
      underlying: u,
      // No onRejected: a refused live manager OPEN is recorded, never paper-traded.
    });
    switch (placed.kind) {
      case 'PLACED':
        return { result: { status: 'DONE', detail: `live ${what}, order ${placed.brokerOrderId}`, ref: placed.orderRowId }, keepFilled: true, entry, stop: stopState, orderRowId: placed.orderRowId };
      case 'DUPLICATE':
        return { result: refused('this decision already has an order — nothing sent'), keepFilled: false, entry };
      case 'UNCERTAIN':
        // The order MAY exist: keep the row so the stop is armed if a tracker appears.
        return { result: { status: 'FAILED', detail: `UNCERTAIN: ${placed.reason} — the order may exist, check the broker`, ref: placed.orderRowId ?? undefined }, keepFilled: true, entry, stop: stopState, orderRowId: placed.orderRowId };
      case 'FAILED':
        return { result: { status: 'FAILED', detail: `not sent: ${placed.reason}`, ref: placed.orderRowId ?? undefined }, keepFilled: false, entry };
      default:
        return { result: { status: 'REFUSED', detail: `${placed.kind}: ${placed.reason}`, ref: placed.orderRowId ?? undefined }, keepFilled: false, entry };
    }
  }

  private async brokerMargin(owner: string, plan: Parameters<typeof marginPosition>[0], qtyUnit: 'units' | 'lots' | null): Promise<BrokerMargin> {
    if (!this.funds?.margin) return { ok: false, reason: 'margin calculator not wired' };
    try {
      return parseMarginResponse(await this.funds.margin(owner, marginPosition(plan, this.traderCfg.product, qtyUnit)));
    } catch (err) {
      return { ok: false, reason: errText(err).slice(0, 160) };
    }
  }

  private async readFunds(owner: string): Promise<number | null> {
    if (!this.funds) return null;
    try {
      const v = await this.funds.available(owner);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }
}

interface Acted {
  result: ActionResult;
  /** true = the row stays FILLED (an order / paper trade exists or may exist) and its stop waits to be armed. */
  keepFilled: boolean;
  entry?: Record<string, unknown>;
  stop?: EntryStopState;
  orderRowId?: string | null;
  tradeId?: string | null;
}

const refused = (detail: string): ActionResult => ({ status: 'REFUSED', detail });
const failed = (detail: string): ActionResult => ({ status: 'FAILED', detail });

/** ZONE needs low ≤ high; BREAKOUT a trigger; a waiting entry 1–390 min. null = fine. */
export function entryShapeProblem(d: OpenDecision): string | null {
  const e = d.entry;
  if (e.type === 'ZONE' && !(finite(e.low) && finite(e.high) && e.low <= e.high)) return 'ZONE entry needs low ≤ high';
  if (e.type === 'BREAKOUT' && !(finite(e.triggerAbove) || finite(e.triggerBelow))) return 'BREAKOUT entry needs triggerAbove or triggerBelow';
  if (e.type !== 'NOW' && !(finite(e.validMin) && e.validMin >= 1 && e.validMin <= 390)) return 'a waiting entry needs validMin 1–390';
  return null;
}

/** True when the underlying's price meets a waiting entry. */
export function entryMet(d: OpenDecision, ltp: number): boolean {
  const e = d.entry;
  if (e.type === 'ZONE') return finite(e.low) && finite(e.high) && ltp >= e.low && ltp <= e.high;
  if (e.type === 'BREAKOUT') return (finite(e.triggerAbove) && ltp >= e.triggerAbove) || (finite(e.triggerBelow) && ltp <= e.triggerBelow);
  return true;
}

function describeEntry(d: OpenDecision): string {
  const e = d.entry;
  if (e.type === 'ZONE') return `ZONE ${e.low}–${e.high} on ${d.underlying}`;
  if (e.type === 'BREAKOUT') return `BREAKOUT ${finite(e.triggerAbove) ? `≥ ${e.triggerAbove}` : ''}${finite(e.triggerAbove) && finite(e.triggerBelow) ? ' / ' : ''}${finite(e.triggerBelow) ? `≤ ${e.triggerBelow}` : ''} on ${d.underlying}`;
  return `NOW on ${d.underlying}`;
}
