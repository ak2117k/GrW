import { Inject, Injectable, Logger } from '@nestjs/common';
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
  | { kind: 'ready'; verdict: { id: string; createdAt: Date }; packet: PacketFacts; history: HistoryVerdict[]; maxLossPerTrade: number | null; dailyLossLatched: boolean }
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
  ) {}

  enabled(): boolean {
    return this.cfg.enabled;
  }

  async load(v: PendingVerdict, now: Date): Promise<GateContext> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GateContext>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'unreadable', reason: `gate facts timed out after ${GATE_LOAD_TIMEOUT_MS} ms` }), GATE_LOAD_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.read(v, now), timeout]);
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
      return record;
    } catch (err) {
      this.logger.warn(`[exit-gate] evaluation threw — failing OPEN: ${errText(err)}`);
      return bypassRecord('FACTS_UNREADABLE', this.cfg, live.now, errText(err));
    }
  }
}
