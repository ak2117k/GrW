/**
 * Trade agent exit authority: DI tokens and port interfaces
 * (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md).
 * Consumers inject these with @Optional() @Inject(TOKEN); an absent port means the feature is off for them.
 */

export type AlarmUrgency = 'normal' | 'urgent' | 'deadline';
export type AlarmRule =
  | 'HARD_LOSS'
  | 'HARD_LOSS_FAST'
  | 'FLOOR'
  | 'LADDER'
  | 'PRICE_TRIGGER'
  | 'CARRY'
  | 'TARGET_LOCK'
  | 'SUPREME_EXIT';

export interface RaiseAlarm {
  userId: string;
  trackerId: string;
  symbol: string;
  rule: AlarmRule;
  urgency: AlarmUrgency;
  /** ≤500 chars, shown to the agent and owner. */
  reason: string;
  /** What the old rule would have done, e.g. "EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED". */
  wouldHave: string;
  /** Required when urgency === 'deadline'. */
  deadline?: Date | null;
  /** How far past the rule in N15 (for re-raise); null if unknown. */
  severityN?: number | null;
  /** verdictId / trigger id / decision id that raised it. */
  sourceRef?: string | null;
  /** Free facts (netPnl, limit, level…). */
  payload?: Record<string, unknown>;
}

export type AlarmStatus = 'OPEN' | 'ANSWERED' | 'SNOOZED' | 'BACKSTOPPED' | 'CLOSED';

export interface AlarmRow extends RaiseAlarm {
  id: string;
  status: AlarmStatus;
  raisedAt: Date;
  lastRaisedAt: Date;
  answeredAt: Date | null;
  answerVerdictId: string | null;
  answer: string | null;
  alertedAt: Date | null;
  alertCount: number;
  telegramMessageId: number | null;
  snoozedUntil: Date | null;
}

export const TRADE_ALARMS = Symbol('TRADE_ALARMS');
export interface TradeAlarmsPort {
  /** Persists (or re-raises per shouldReRaise) and wakes the tracker's agent. null = deduped (an open alarm already covers it). */
  raise(a: RaiseAlarm, now?: Date): Promise<AlarmRow | null>;
  openFor(trackerId: string): Promise<AlarmRow[]>;
  /** One read per sentinel user pass. */
  openForTrackers(trackerIds: string[]): Promise<AlarmRow[]>;
  answer(alarmId: string, verdictId: string, answer: string, now?: Date): Promise<void>;
}

export const AUTHORITY_STATE = Symbol('AUTHORITY_STATE');
export interface AuthorityStatePort {
  isLive(): boolean;
}

export const TRACKER_WAKE = Symbol('TRACKER_WAKE');
export interface TrackerWakePort {
  wakeTracker(userId: string, trackerId: string, why: string): void;
}

export const SUPREME_CONFIRM = Symbol('SUPREME_CONFIRM');
export interface ConfirmRequest {
  userId: string;
  trackerId: string;
  symbol: string;
  agentDecision: 'EXIT' | 'BOOK';
  agentReason: string;
  alarm: AlarmRow | null;
  brief: string | null;
  packetSummary: string;
  /** SUPREME_EXIT round-trip: the agent disagreed with the supreme's own request. */
  agentDisagrees?: boolean;
}
export interface ConfirmResult {
  decision: 'CONFIRM' | 'OVERRIDE_HOLD' | 'TIMEOUT' | 'ERROR';
  reason: string;
  briefNote?: string | null;
  latencyMs: number;
}
export interface SupremeConfirmPort {
  confirm(req: ConfirmRequest): Promise<ConfirmResult>;
}

export const TRADE_BRIEFS = Symbol('TRADE_BRIEFS');
export interface TradeBriefsPort {
  briefFor(trackerId: string): Promise<string | null>;
  write(trackerId: string, userId: string, text: string, by: 'OPEN' | 'MANAGER' | 'CONFIRM'): Promise<void>;
}

export const OWNER_ESCALATION = Symbol('OWNER_ESCALATION');
export interface OwnerEscalationPort {
  blockedExit(input: { userId: string; trackerId: string; symbol: string; reason: string; detail: string }): Promise<void>;
}
