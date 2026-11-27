import type { AlarmRow, AlarmRule, AlarmUrgency } from '../../exit-authority/exit-authority.tokens';
import { TRACKER_WAKE_MIN_GAP_MS } from '../../exit-authority/domain/timings';
import type { TripwireFire } from '../tripwires/types';

/**
 * TRADE AGENT EXIT AUTHORITY (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md), the
 * sentinel side of the forced look. With the authority live, a code rule that would have sold a live trade
 * raises an ALARM instead (trade_alarms); the trade's agent must then look at it. Modelled on the deadline
 * look (square-off-look.ts): one `alarm` fire, injected AFTER every wake gate, so the rate cap, re-judge
 * suppression and futile suppression can never drop it. Pure.
 */

/** The fire name of the forced alarm look (packet trigger, verdict triggeredBy). */
export const ALARM_FIRE = 'alarm';

/** The forced look's fire: a tripwire fire that also names the alarm it answers. */
export interface AlarmFire extends TripwireFire {
  kind: 'alarm';
  alarmId: string;
  rule: AlarmRule;
  reason: string;
}

/** The packet's `alarm` block (ContextPacket.alarm). A `type` so it stays Prisma-JSON assignable. */
export type PacketAlarm = {
  rule: AlarmRule;
  reason: string;
  urgency: AlarmUrgency;
  /** ISO time of the alarm's deadline (urgency `deadline`), else null. */
  deadline: string | null;
  /** ISO time the alarm was (last) raised. */
  raisedAt: string;
};

const URGENCY_RANK: Record<AlarmUrgency, number> = { urgent: 0, deadline: 1, normal: 2 };

const ms = (d: Date | string | null | undefined): number | null => {
  if (d === null || d === undefined) return null;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? t : null;
};

/** When the alarm was last put to the agent: its latest re-raise, else its first raise. */
export const alarmRaisedMs = (a: Pick<AlarmRow, 'raisedAt' | 'lastRaisedAt'>): number =>
  ms(a.lastRaisedAt) ?? ms(a.raisedAt) ?? 0;

/** OPEN, or SNOOZED with the snooze run out (a forgotten SNOOZED must not hide an alarm). */
export function alarmActive(a: Pick<AlarmRow, 'status' | 'snoozedUntil'>, nowMs: number): boolean {
  if (a.status === 'OPEN') return true;
  if (a.status !== 'SNOOZED') return false;
  const until = ms(a.snoozedUntil);
  return until === null || until <= nowMs;
}

/** The alarm that speaks for the trade this pass: most urgent first, then the latest raised. Null when none is active. */
export function leadAlarm(rows: readonly AlarmRow[] | undefined, nowMs: number): AlarmRow | null {
  const live = (rows ?? []).filter((a) => alarmActive(a, nowMs));
  if (live.length === 0) return null;
  return [...live].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || alarmRaisedMs(b) - alarmRaisedMs(a))[0];
}

/** The newest verdict the AGENT wrote (never a `rule:` stamp), from the cycle's recent live rows. */
export function lastAgentVerdictMs(recent: ReadonlyArray<{ createdAt: Date; promptVersion?: string | null }>): number | null {
  const row = recent.find((r) => !String(r.promptVersion ?? '').startsWith('rule:'));
  return row ? ms(row.createdAt) : null;
}

/**
 * The forced look's fire for this pass, or null. Owed when the lead alarm was raised AFTER the agent's last
 * verdict (it has not answered this alarm yet), and not within {@link TRACKER_WAKE_MIN_GAP_MS} of the last
 * forced look on this trade (`lastLookMs`) — so two passes seconds apart judge it once.
 */
export function alarmLookFire(
  alarm: AlarmRow | null,
  lastAgentMs: number | null,
  lastLookMs: number | null,
  nowMs: number,
): AlarmFire | null {
  if (!alarm) return null;
  if (lastAgentMs !== null && lastAgentMs >= alarmRaisedMs(alarm)) return null;
  if (lastLookMs !== null && nowMs - lastLookMs < TRACKER_WAKE_MIN_GAP_MS) return null;
  return {
    name: ALARM_FIRE,
    detail: `${alarm.rule} alarm (${alarm.urgency}): ${alarm.reason}`.slice(0, 500),
    kind: 'alarm',
    alarmId: alarm.id,
    rule: alarm.rule,
    reason: alarm.reason,
  };
}

/** The packet's `alarm` block for an alarm row. */
export function packetAlarm(a: AlarmRow): PacketAlarm {
  const raised = alarmRaisedMs(a);
  const deadline = ms(a.deadline ?? null);
  return {
    rule: a.rule,
    reason: a.reason,
    urgency: a.urgency,
    deadline: deadline === null ? null : new Date(deadline).toISOString(),
    raisedAt: new Date(raised).toISOString(),
  };
}
