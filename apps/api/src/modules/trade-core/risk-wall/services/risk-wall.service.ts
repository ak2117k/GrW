import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../../market-hub/session-clock';
import { CORE_SESSION_CLOCK, RISK_STATE_PROVIDER, RISK_VERDICT_SINK, type RiskStateProvider, type RiskVerdictSink } from '../ports';
import { checkRisk, exitVerdict, rejectVerdict } from '../risk-wall';
import type { CoreIntent, LimitInForce, RiskVerdict } from '../risk-wall.types';
import { CoreKillSwitchService } from './core-kill-switch.service';
import { CoreRiskLimitService } from './core-risk-limit.service';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * RiskWall.check with its inputs (spec §5.1): the intent user's limits in force, kill
 * switch and live state, plus the session for the intent's exchange. Fails closed at
 * every step and records every verdict (plan decisions 2 and 4). Exits are never
 * checked and never blocked, not even by a recording failure.
 */
@Injectable()
export class RiskWallService {
  private readonly logger = new Logger(RiskWallService.name);

  constructor(
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchService,
    @Inject(RISK_STATE_PROVIDER) private readonly stateProvider: RiskStateProvider,
    @Inject(RISK_VERDICT_SINK) private readonly sink: RiskVerdictSink,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
  ) {}

  async check(intent: CoreIntent, now: Date = new Date()): Promise<RiskVerdict> {
    if (intent.kind === 'EXIT') {
      const v = exitVerdict(intent, now);
      try {
        await this.sink.record(v);
      } catch (err) {
        this.logger.error(`could not record exit verdict ${intent.intentId}: ${errorText(err)}`);
      }
      return v;
    }

    let verdict: RiskVerdict;
    let limits: LimitInForce[] = [];
    let killSwitchActive: boolean | null = null;
    try {
      limits = await this.limits.inForce(intent.userId, now);
      killSwitchActive = await this.killSwitch.isActive(intent.userId, now);
      const state = await this.stateProvider.liveState(intent.userId, now);
      verdict = checkRisk(intent, { now, limits, killSwitchActive, sessionOpen: this.clock.isOpen(intent.exchange, now), state });
    } catch (err) {
      verdict = rejectVerdict(intent, now, 'CONTEXT_UNAVAILABLE', `risk context unavailable: ${errorText(err)}`, { limits, killSwitchActive });
    }

    try {
      await this.sink.record(verdict);
    } catch (err) {
      this.logger.error(`could not record risk verdict ${intent.intentId}: ${errorText(err)}`);
      if (verdict.verdict !== 'REJECT') {
        verdict = rejectVerdict(intent, now, 'JOURNAL_UNAVAILABLE', `the verdict could not be recorded: ${errorText(err)}`, verdict);
      }
    }
    return verdict;
  }
}
