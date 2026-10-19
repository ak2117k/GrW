import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { marginFor } from '../execution/margin';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CORE_CORPUS, CORE_JOURNAL, CORE_TRADE_HISTORY, type CoreCorpusPort, type CoreJournalPort, type CoreTradeHistory } from '../journal/journal-ports';
import type { CorpusSetup, SkipReason } from '../journal/journal.types';
import { CoreLifecycleService } from '../lifecycle/core-lifecycle.service';
import { resolveStopPct, round2 } from '../lifecycle/exit-plan';
import type { CoreEntryIntent, RiskVerdict, RiskVerdictKind } from '../risk-wall/risk-wall.types';
import { RiskWallService } from '../risk-wall/services/risk-wall.service';
import { CoreStrategySelectionRepository, type LiveSelection } from '../strategies/repositories/core-strategy-selection.repository';
import { setCoreAlertIntake, type ChartinkHit, type CoreAlertIntake } from './alert-handoff';
import { CORE_ENTRY_CONFIG, type EntryConfig } from './entry-config';
import { EntryMarket, intakeOwner } from './entry-market';
import { cooldownActive, intentIdFor, lastLossVerdict, matchEntry, setupGroupKey, sizeQty, staleEntryFails, staleMovePct, stopPriceFor } from './entry-rules';
import { MBM_GATE_KEY, runGates, type GateOutcome, type MbmGateAccess } from './gate-evaluators';
import { mbmInstrumentFor } from '../../mbm/domain/mbm-applies';
import { mbmEntryGateMode } from '../../mbm/mbm.config';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';

/** Load bound (Global Constraints): hits waiting for the sequential intake. */
export const INTAKE_MAX_PENDING = 200;

export type IntakeOutcome =
  | { kind: 'DUPLICATE'; intentId: string }
  | { kind: 'SKIPPED'; intentId: string; reason: SkipReason; detail: string }
  | { kind: 'DRY_RUN'; intentId: string; verdict: RiskVerdictKind; qty: number }
  | { kind: 'OPENED'; intentId: string; positionId: string; qty: number };

type AttemptOutcome = IntakeOutcome | { kind: 'NOT_MINE' };

interface Attempt {
  sel: LiveSelection;
  hit: ChartinkHit;
  intentId: string;
  at: Date;
  evidence: Record<string, unknown>;
  /** MBM M3: set when the market-behaviour gate applied (CorpusSetup.mbm). */
  mbm?: CorpusSetup['mbm'];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §3 entry source (rulings J2–J9, J24): Chartink hits handed off by ChartinkProcessService are
 * queued and processed one at a time. For each enabled PAPER selection of an allow-listed user whose
 * entry block matches: alert age → filters (cheap first) → hub price → stale entry → gates → ATR → sizing →
 * RiskWallService.check → (paper) CoreLifecycleService.openPosition. Every skip is journaled with its
 * reason; nothing here throws back to Chartink, and nothing here touches an exit.
 */
@Injectable()
export class CoreEntryIntake implements CoreAlertIntake, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreEntryIntake.name);
  private readonly queue: ChartinkHit[] = [];
  private draining: Promise<void> | null = null;
  private dropped = 0;

  constructor(
    @Inject(CORE_ENTRY_CONFIG) private readonly config: EntryConfig,
    private readonly selections: CoreStrategySelectionRepository,
    private readonly wall: RiskWallService,
    private readonly lifecycle: CoreLifecycleService,
    private readonly defaults: CorePaperDefaultsService,
    private readonly market: EntryMarket,
    @Inject(CORE_TRADE_HISTORY) private readonly history: CoreTradeHistory,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
  ) {}

  /** MBM M3 `market-behaviour` gate inputs; one MbmClient.behaviour call per attempt at most. */
  private mbmGateAccess(hit: ChartinkHit): MbmGateAccess {
    const m = this.market.mbm();
    const mode = m ? mbmEntryGateMode(m.config) : 'off';
    const instrument = m && mode !== 'off' ? mbmInstrumentFor({ symbol: hit.tradingSymbol, exchange: hit.exchange }, m.config.instruments) : null;
    let fetched: Promise<MbmBehaviour> | null = null;
    return {
      mode,
      instrument,
      behaviour: (i) => (fetched ??= m ? m.client.behaviour(i) : Promise.resolve({ instrument: i, status: 'absent' as const })),
    };
  }

  /** MBM M3: the gate's applied answer → the decision record's features / featureSet / mlScore. */
  private static mbmRecord(outcomes: readonly GateOutcome[]): Attempt['mbm'] {
    const d = outcomes.find((o) => o.key === MBM_GATE_KEY)?.detail;
    if (!d || d.applies !== true || typeof d.p !== 'number') return undefined;
    const { regime, p, rangeBp, q50Bp, asOf, modelId, horizon, instrument, wouldSkip, mode } = d;
    const featureSet = typeof d.featureSet === 'string' && d.featureSet ? d.featureSet : 'mbm';
    return { features: { instrument, horizon, regime, p, rangeBp, q50Bp, asOf, modelId, wouldSkip, mode }, featureSet, mlScore: p };
  }

  onModuleInit(): void {
    if (this.config.mode === 'off') {
      this.logger.log('core entries are off (CORE_ENTRIES_MODE)');
      return;
    }
    setCoreAlertIntake(this);
    this.logger.warn(`core entries: ${this.config.mode} mode for ${this.config.userIds.size} user(s) (CORE_ENTRY_USER_IDS)`);
  }

  onModuleDestroy(): void {
    setCoreAlertIntake(null);
  }

  status(): { mode: EntryConfig['mode']; users: number; pending: number; dropped: number } {
    return { mode: this.config.mode, users: this.config.userIds.size, pending: this.queue.length, dropped: this.dropped };
  }

  /** The hand-off target: queue and return at once. A full queue drops the hit (counted, logged). */
  accept(hit: ChartinkHit): void {
    if (this.queue.length >= INTAKE_MAX_PENDING) {
      this.dropped += 1;
      this.logger.error(`core intake backlog full (${INTAKE_MAX_PENDING}): ${hit.symbol} from alert ${hit.alertId} dropped`);
      return;
    }
    this.queue.push(hit);
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null; });
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      try {
        await this.process(next);
      } catch (err) {
        this.logger.error(`core intake ${next.symbol} (alert ${next.alertId}) failed: ${errorText(err)}`);
      }
    }
  }

  async process(hit: ChartinkHit, now: Date = new Date()): Promise<IntakeOutcome[]> {
    // Fail closed: with entries off nothing is processed, even when called directly.
    if (this.config.mode === 'off') return [];
    let live: LiveSelection[];
    try {
      live = await this.selections.listEnabledPaper();
    } catch (err) {
      this.logger.error(`core intake: selections unreadable, ${hit.symbol} from alert ${hit.alertId} skipped: ${errorText(err)}`);
      return [];
    }
    const out: IntakeOutcome[] = [];
    for (const sel of live) {
      if (!this.config.userIds.has(sel.userId)) continue;
      try {
        const o = await this.attempt(sel, hit, now);
        if (o.kind !== 'NOT_MINE') out.push(o);
      } catch (err) {
        // Before the attempt's own guard (duplicate check, ALERT_RECEIVED): no entry, no throw.
        this.logger.error(`core intake ${hit.symbol} (alert ${hit.alertId}) for ${sel.userId}/${sel.strategyKey} failed: ${errorText(err)}`);
      }
    }
    return out;
  }

  private async attempt(sel: LiveSelection, hit: ChartinkHit, now: Date): Promise<AttemptOutcome> {
    const m = matchEntry(sel.blocks, hit, now);
    if (m.kind === 'NOT_MINE') return m;
    const intentId = intentIdFor(sel.userId, sel.strategyId, hit.alertId, hit.token);
    if (await this.history.intentSeen(intentId)) return { kind: 'DUPLICATE', intentId };
    const a: Attempt = {
      sel, hit, intentId, at: now,
      evidence: { source: 'chartink', alertId: hit.alertId, scanName: hit.scanName, side: hit.side, score: hit.score, alertPrice: hit.hitPrice, capitalAllocation: sel.capitalAllocation },
    };
    this.journal.record({
      type: 'ALERT_RECEIVED', userId: sel.userId, at: now, strategyId: sel.strategyId, strategyVersionId: sel.strategyVersionId, intentId,
      symbol: hit.tradingSymbol, payload: { ...a.evidence, token: hit.token, exchange: hit.exchange, strategyKey: sel.strategyKey }, priceUsed: hit.hitPrice,
      dedupeKey: `alert:${intentId}`,
    });
    if (m.kind === 'SKIP') return this.skip(a, m.reason, m.detail);
    const stale = this.staleAlert(hit, now);
    if (stale) return this.skip(a, 'STALE_ALERT', stale);

    const ref: InstrumentRef = { exchange: hit.exchange, token: hit.token, symbol: hit.tradingSymbol };
    const owner = intakeOwner(intentId);
    let watched = false;
    try {
      const b = sel.blocks;
      if (b.filters.cooldown) {
        const last = await this.history.lastOpenedAt(sel.userId, sel.strategyId, hit.token);
        if (cooldownActive(b.filters.cooldown, last, now)) {
          return await this.skip(a, 'COOLDOWN', `opened ${hit.symbol} at ${last?.toISOString()}; cooldown ${b.filters.cooldown.minutes} min`);
        }
      }
      if (b.filters.lastLoss) {
        const last = await this.history.lastClosedNetToday(sel.userId, sel.strategyId, hit.token, now);
        const v = lastLossVerdict(b.filters.lastLoss, last);
        if (v === 'BLOCK') return await this.skip(a, 'LAST_LOSS', `today's last closed trade on ${hit.symbol} netted ₹${String(last)}`);
        if (v === 'UNKNOWN') return await this.skip(a, 'HISTORY_UNKNOWN', `today's last closed trade on ${hit.symbol} has no summary yet`);
      }

      watched = true;
      const p = await this.market.freshPrice(sel.userId, ref, owner);
      if (!p.ok) return await this.skip(a, p.reason, p.detail);
      a.evidence.ltp = p.ltp;
      if (staleEntryFails(b.filters.staleEntry, hit.side, hit.hitPrice, p.ltp)) {
        if (!(hit.hitPrice > 0)) return await this.skip(a, 'STALE_ENTRY', `the alert price ₹${hit.hitPrice} cannot be judged`);
        const moved = staleMovePct(hit.side, hit.hitPrice, p.ltp).toFixed(2);
        return await this.skip(a, 'STALE_ENTRY', `moved ${moved}% past the alert price ₹${hit.hitPrice} (max ${b.filters.staleEntry?.maxMovePct}%)`);
      }
      if (b.filters.gates.length > 0) {
        const g = await runGates(b.filters.gates, { entryPrice: p.ltp, now, candles: (tf, days) => this.market.candlesFor(ref, tf, days, now), mbm: this.mbmGateAccess(hit) });
        a.evidence.gates = g.outcomes;
        a.mbm = CoreEntryIntake.mbmRecord(g.outcomes);
        if (g.unknown) return await this.skip(a, 'GATE_UNKNOWN', `no evaluator is registered for ${g.unknown}`);
        if (!g.pass) return await this.skip(a, 'GATE', g.outcomes[g.outcomes.length - 1]?.reason ?? 'a gate failed');
      }
      const settings = await this.defaults.settings(now.getTime());
      if (!settings.ok) return await this.skip(a, 'PAPER_SETTINGS_MISSING', `missing paper defaults: ${settings.missing.join(', ')}`);

      const atr = await this.market.atr(ref, b.stop, now);
      const latest = await this.market.freshPrice(sel.userId, ref, owner, 0);
      const refPrice = latest.ok ? latest.ltp : p.ltp;
      const stopPct = resolveStopPct(b.stop, refPrice, atr.atr);
      const stopPrice = stopPriceFor(hit.side, refPrice, stopPct);
      const qty = sizeQty(b.sizing, refPrice, stopPrice, 1);
      Object.assign(a.evidence, { refPrice, atr: atr.atr, atrSource: atr.source, atrDetail: atr.detail, stopPct, stopPrice, qty });
      if (qty < 1) return await this.skip(a, 'SIZE_ZERO', `${b.sizing.kind} ₹${b.sizing.amount} buys no unit at ₹${refPrice} with the stop at ₹${stopPrice}`);

      const vehicle = b.vehicle.kind === 'MTF' ? 'MTF' : 'CASH_INTRADAY';
      const capitalPerUnit = marginFor(vehicle, new Prisma.Decimal(refPrice), settings.settings).toNumber();
      const intent: CoreEntryIntent = {
        kind: 'ENTRY',
        intentId,
        userId: sel.userId,
        strategyId: sel.strategyId,
        strategyVersionId: sel.strategyVersionId,
        vehicle,
        exchange: hit.exchange,
        symbol: hit.tradingSymbol,
        underlying: hit.symbol.trim().toUpperCase(),
        side: hit.side,
        optionType: null,
        qty,
        lotSize: 1,
        refPrice,
        refPriceFresh: latest.ok,
        stopPrice,
        capitalPerUnit,
        mtfLeverage: vehicle === 'MTF' && capitalPerUnit > 0 ? round2(refPrice / capitalPerUnit) : null,
      };
      // The alert may have aged past the max while prices, gates and candles were read.
      const late = this.staleAlert(hit, new Date());
      if (late) return await this.skip(a, 'STALE_ALERT', late);
      const verdict = await this.wall.check(intent, new Date());
      a.evidence.verdict = { verdict: verdict.verdict, qty: verdict.qty, reasons: verdict.reasons.map((r) => r.code) };
      if (verdict.verdict === 'REJECT') return await this.skip(a, 'RISK_REJECT', verdict.reasons.map((r) => `${r.code}: ${r.message}`).join('; '));
      // The wall may only reduce the quantity (J8); anything else is not trusted (fail closed).
      if (!(Number.isInteger(verdict.qty) && verdict.qty >= 1 && verdict.qty <= qty)) {
        return await this.skip(a, 'RISK_REJECT', `the verdict quantity ${verdict.qty} is outside 1..${qty} (${verdict.verdict})`);
      }
      if (this.config.mode !== 'paper') return this.dryRun(a, verdict);

      let positionId: string;
      try {
        const pos = await this.lifecycle.openPosition(
          { intent, qty: verdict.qty, instrument: { exchange: hit.exchange, token: hit.token, symbol: hit.tradingSymbol, lotSize: 1, underlying: null }, atr: atr.atr, limits: verdict.limits, option: null },
          new Date(),
        );
        positionId = pos.id;
      } catch (err) {
        return await this.skip(a, 'OPEN_REFUSED', errorText(err));
      }
      await this.setup(a, true, `opened ${positionId} for ${verdict.qty}`);
      return { kind: 'OPENED', intentId, positionId, qty: verdict.qty };
    } catch (err) {
      return this.skip(a, 'INTERNAL_ERROR', errorText(err));
    } finally {
      if (watched) this.market.release(sel.userId, ref, owner);
    }
  }

  /**
   * Review fix 2: an alert older than maxAlertAgeMs since it was stored never opens (a late hand-off,
   * a Bull re-run after a restart, a hit that skipped and comes round again). Unknown age fails closed.
   */
  private staleAlert(hit: ChartinkHit, now: Date): string | null {
    if (!hit.alertAt) return 'the alert time is unknown';
    const ageMs = now.getTime() - hit.alertAt.getTime();
    if (ageMs <= this.config.maxAlertAgeMs) return null;
    return `the alert is ${Math.round(ageMs / 1000)} s old (max ${Math.round(this.config.maxAlertAgeMs / 1000)} s)`;
  }

  private skipEntry(a: Attempt, reason: SkipReason, detail: string, extra: Record<string, unknown> = {}) {
    const ltp = typeof a.evidence.ltp === 'number' ? a.evidence.ltp : null;
    return {
      type: 'INTENT_SKIPPED' as const,
      userId: a.sel.userId,
      at: new Date(),
      strategyId: a.sel.strategyId,
      strategyVersionId: a.sel.strategyVersionId,
      intentId: a.intentId,
      symbol: a.hit.tradingSymbol,
      payload: { reason, detail, token: a.hit.token, exchange: a.hit.exchange, side: a.hit.side, alertPrice: a.hit.hitPrice, ltp, ...extra },
      priceUsed: ltp,
      dedupeKey: `skip:${a.intentId}`,
    };
  }

  private async skip(a: Attempt, reason: SkipReason, detail: string): Promise<IntakeOutcome> {
    this.journal.record(this.skipEntry(a, reason, detail));
    // O9 (owner 2026-10-13): corpus rows in every trading mode. The only exclusion is J9's dry-run
    // entries switch (CORE_ENTRIES_MODE=journal), where nothing is traded; it is not a trading mode.
    if (!this.dryRunSwitch()) await this.setup(a, false, `${reason}: ${detail}`);
    return { kind: 'SKIPPED', intentId: a.intentId, reason, detail };
  }

  /** J9: CORE_ENTRIES_MODE=journal runs everything up to the verdict and opens nothing. */
  private dryRunSwitch(): boolean {
    return this.config.mode === 'journal';
  }

  private dryRun(a: Attempt, v: RiskVerdict): IntakeOutcome {
    const detail = `would open ${v.qty} (${v.verdict}); CORE_ENTRIES_MODE=${this.config.mode}`;
    this.journal.record(this.skipEntry(a, 'ENTRIES_DRY_RUN', detail, { verdict: a.evidence.verdict }));
    return { kind: 'DRY_RUN', intentId: a.intentId, verdict: v.verdict, qty: v.qty };
  }

  /** O9: the corpus row; a failure is logged and never affects the entry. */
  private async setup(a: Attempt, taken: boolean, reason: string): Promise<void> {
    try {
      await this.corpus.entrySetup({
        intentId: a.intentId,
        userId: a.sel.userId,
        decidedAt: a.at,
        symbol: a.hit.tradingSymbol,
        exchange: a.hit.exchange,
        vehicle: a.sel.blocks.vehicle.kind,
        direction: a.hit.side === 'BUY' ? 'LONG' : 'SHORT',
        strategyKey: a.sel.strategyKey,
        strategyVersionId: a.sel.strategyVersionId,
        setupGroupKey: setupGroupKey(a.hit.alertId, a.hit.symbol, a.at),
        evidence: a.evidence,
        ruleScore: a.hit.score,
        decision: { taken, reason },
        ...(a.mbm ? { mbm: a.mbm } : {}),
      });
    } catch (err) {
      this.logger.warn(`corpus setup ${a.intentId} not written: ${errorText(err)}`);
    }
  }
}
