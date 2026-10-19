import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MBM_CONFIG, type MbmConfig } from '../../mbm/mbm.config';
import { mbmInstrumentFor } from '../../mbm/domain/mbm-applies';
// A VALUE import: MbmClient is injected by class.
import { MbmClient } from '../../mbm/services/mbm-client.service';
import { mbmExitShadow, mbmExitShadowLine, type MbmShadowSlot } from '../domain/mbm-exit-shadow';
import { EXIT_DISCIPLINE_CONFIG, GATE_LOAD_TIMEOUT_MS, STREAK_LOOKBACK_MIN, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { buildGateFacts, bypassRecord, decideExit, istDate } from '../../exit-discipline/decision';
import { readPacketFacts, type PacketFacts } from '../../exit-discipline/packet-facts';
import type { HistoryVerdict } from '../../exit-discipline/persistence';
import type { GateRecordV1 } from '../../exit-discipline/types';
import type { SessionClock } from '../../market-hub/session-clock';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { ExitGateRepository } from '../repositories/exit-gate.repository';
import { AI_EXIT_SESSION_CLOCK } from './executor.tokens';

export type GateContext =
  | {
      kind: 'ready'; verdict: { id: string; createdAt: Date }; packet: PacketFacts; history: HistoryVerdict[]; maxLossPerTrade: number | null; dailyLossLatched: boolean;
      /** MBM_EXIT_SHADOW observe|on only: the shadow's MBM read, never awaited by `decide`. */
      mbm?: MbmShadowSlot;
    }
  | { kind: 'unreadable'; reason: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Exit discipline §6/§7 for AI EXIT_NOW verdicts ONLY. Reads, never writes, never
 * touches the broker. The executor calls `load` concurrently with its session
 * lease and `decide` after its first pre-order check (plan R8).
 */
@Injectable()
export class ExitGateService {
  private readonly logger = new Logger(ExitGateService.name);

  constructor(
    private readonly repo: ExitGateRepository,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'minutesToClose'> & Partial<Pick<SessionClock, 'tradingWindow'>>,
    @Inject(EXIT_DISCIPLINE_CONFIG) private readonly cfg: ExitDisciplineConfig,
    /** MBM M3 shadow — both optional: absent, or `exitShadow: 'off'`, ⇒ MBM is never asked. */
    @Optional() @Inject(MBM_CONFIG) private readonly mbmCfg?: MbmConfig,
    @Optional() private readonly mbm?: MbmClient,
  ) {}

  /**
   * MBM_EXIT_SHADOW observe|on: start the (cached, fail-open) MBM read for this verdict's symbol.
   * PendingVerdict carries no exchange, so the F&O mapping is tried first and `decide` re-checks it
   * against the live exchange. Never awaited by the gate; never rejects.
   */
  private startMbmShadow(v: PendingVerdict, now: Date): MbmShadowSlot | null {
    const cfg = this.mbmCfg;
    if (!cfg || cfg.exitShadow === 'off' || !this.mbm) return null;
    try {
      const instrument =
        mbmInstrumentFor({ symbol: v.symbol, exchange: 'NFO' }, cfg.instruments) ?? mbmInstrumentFor({ symbol: v.symbol, exchange: 'NSE' }, cfg.instruments);
      if (!instrument) return null;
      const slot: MbmShadowSlot = { symbol: v.symbol, instrument, settled: false, answer: null };
      this.mbm.behaviour(instrument, now.getTime()).then(
        (b) => { slot.answer = b; slot.settled = true; },
        () => { slot.settled = true; },
      );
      return slot;
    } catch {
      return null;
    }
  }

  /** Beside the decision, never in it: the record is returned with the same outcome either way. */
  private withMbmShadow(ctx: GateContext, live: { exchange: string }, record: GateRecordV1): GateRecordV1 {
    if (ctx.kind !== 'ready' || !ctx.mbm || record.outcome === 'BYPASS') return record;
    try {
      const slot = ctx.mbm;
      if (mbmInstrumentFor({ symbol: slot.symbol, exchange: live.exchange }, this.mbmCfg?.instruments ?? []) !== slot.instrument) return record;
      const shadow = mbmExitShadow(slot, record, record.facts?.minutesToClose ?? null);
      this.logger.log(mbmExitShadowLine(shadow, slot.symbol, ctx.verdict.id));
      return { ...record, mbmShadow: shadow };
    } catch (err) {
      this.logger.warn(`[mbm-exit-shadow] skipped: ${errText(err)}`);
      return record;
    }
  }

  enabled(): boolean {
    return this.cfg.enabled;
  }

  async load(v: PendingVerdict, now: Date): Promise<GateContext> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GateContext>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'unreadable', reason: `gate facts timed out after ${GATE_LOAD_TIMEOUT_MS} ms` }), GATE_LOAD_TIMEOUT_MS);
      timer.unref?.();
    });
    // Started beside the facts read, outside its race: MBM can never time the gate facts out.
    const mbm = this.startMbmShadow(v, now);
    try {
      const ctx = await Promise.race([this.read(v, now), timeout]);
      return mbm && ctx.kind === 'ready' ? { ...ctx, mbm } : ctx;
    } catch (err) {
      return { kind: 'unreadable', reason: errText(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async read(v: PendingVerdict, now: Date): Promise<GateContext> {
    const packet = await this.repo.verdictPacket(v.id);
    if (packet == null) return { kind: 'unreadable', reason: 'verdict row not found' };
    const facts = readPacketFacts(packet);
    if ('unreadable' in facts) return { kind: 'unreadable', reason: facts.unreadable };
    const since = new Date(v.createdAt.getTime() - STREAK_LOOKBACK_MIN * 60_000);
    const [history, maxLossPerTrade, dailyLossLatched] = await Promise.all([
      this.repo.recentVerdicts(v.trackerId, v.id, v.createdAt, since),
      this.repo.maxRiskPerTrade(v.userId, now),
      this.repo.dailyLossLatched(v.userId, istDate(now)),
    ]);
    return { kind: 'ready', verdict: { id: v.id, createdAt: v.createdAt }, packet: facts, history, maxLossPerTrade, dailyLossLatched };
  }

  decide(ctx: GateContext, live: { ltpNow: number; productType: string | null; exchange: string; now: Date }): GateRecordV1 {
    if (!this.cfg.enabled) return bypassRecord('DISABLED', this.cfg, live.now);
    if (ctx.kind === 'unreadable') {
      this.logger.warn(`[exit-gate] facts unreadable — failing OPEN (today's behaviour): ${ctx.reason}`);
      return bypassRecord('FACTS_UNREADABLE', this.cfg, live.now, ctx.reason);
    }
    try {
      const w = this.clock.tradingWindow?.(live.exchange, live.now) ?? null;
      const facts = buildGateFacts(ctx.packet, {
        ltpNow: live.ltpNow, productType: live.productType,
        underlyingSessionMinutes: w ? w.closeMin - w.openMin : undefined,
        minutesToClose: this.clock.minutesToClose(live.exchange, live.now),
        maxLossPerTrade: ctx.maxLossPerTrade, dailyLossLatched: ctx.dailyLossLatched, history: ctx.history, now: live.now,
      });
      const record = decideExit({ facts, current: ctx.verdict, history: ctx.history, cfg: this.cfg, now: live.now });
      if (record.outcome === 'BYPASS') this.logger.warn(`[exit-gate] facts unreadable — failing OPEN (today's behaviour): ${record.error ?? record.bypassReason}`);
      return this.withMbmShadow(ctx, live, record);
    } catch (err) {
      this.logger.warn(`[exit-gate] evaluation threw — failing OPEN: ${errText(err)}`);
      return bypassRecord('FACTS_UNREADABLE', this.cfg, live.now, errText(err));
    }
  }
}
