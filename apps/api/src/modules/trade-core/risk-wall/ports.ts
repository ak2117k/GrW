import { Injectable, Logger } from '@nestjs/common';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { RiskLiveState, RiskVerdict } from './risk-wall.types';

/**
 * What M2 needs from later milestones, as injection tokens with fail-closed M2
 * defaults (plan decision 3). M3/M4/M5 rebind them in TradeCoreModule; see the plan's
 * "Notes for later milestones".
 */
export const CORE_SESSION_CLOCK = Symbol('CORE_SESSION_CLOCK');
export const RISK_STATE_PROVIDER = Symbol('RISK_STATE_PROVIDER');
export const RISK_VERDICT_SINK = Symbol('RISK_VERDICT_SINK');
export const CORE_SQUARE_OFF = Symbol('CORE_SQUARE_OFF');

/** The core's clock: the hub's holiday list. MCX late close is left out: no core vehicle trades MCX. */
export function createCoreSessionClock(): SessionClock {
  return new SessionClock({ holidays: MARKET_HOLIDAYS });
}

export interface RiskStateProvider {
  liveState(userId: string, at: Date): Promise<RiskLiveState>;
}

export class RiskStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskStateUnavailableError';
  }
}

/** M2 default: there are no core positions or P&L yet, so every entry is rejected. */
@Injectable()
export class UnavailableRiskStateProvider implements RiskStateProvider {
  async liveState(_userId: string, _at: Date): Promise<RiskLiveState> {
    throw new RiskStateUnavailableError('core positions and P&L are not available until M3/M4 bind RISK_STATE_PROVIDER');
  }
}

export interface RiskVerdictSink {
  record(verdict: RiskVerdict): Promise<void>;
}

/** M2 default: one log line per verdict. M5 rebinds this to core_journal (RISK_VERDICT rows). */
@Injectable()
export class LoggingRiskVerdictSink implements RiskVerdictSink {
  private readonly logger = new Logger('RiskVerdict');

  async record(v: RiskVerdict): Promise<void> {
    this.logger.log(
      JSON.stringify({ intentId: v.intentId, userId: v.userId, verdict: v.verdict, qty: v.qty, requestedQty: v.requestedQty, reasons: v.reasons.map((r) => r.code) }),
    );
  }
}

export type CoreSquareOffCause = 'KILL_SWITCH' | 'DAILY_LOSS';

export interface CoreSquareOffResult {
  cancelledOrders: number;
  exitsRequested: number;
  detail: string;
}

/** Cancels the user's pending core orders and exits all core positions (spec §5.3, §5.4). M3/M4 implement it. */
export interface CoreSquareOffPort {
  squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult>;
}

/** M2 default: truthful, because core_orders and core_positions do not exist before M3/M4. */
@Injectable()
export class NoCorePositionsSquareOff implements CoreSquareOffPort {
  async squareOffAll(_userId: string, _cause: CoreSquareOffCause, _reason: string): Promise<CoreSquareOffResult> {
    return { cancelledOrders: 0, exitsRequested: 0, detail: 'no core orders or positions exist yet (M3/M4 add them)' };
  }
}
