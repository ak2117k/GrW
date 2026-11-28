import type { AlarmRow, AlarmRule, RaiseAlarm } from '../exit-authority.tokens';

/**
 * AUTHORITY DRILL (supreme fixes W5, 2026-11-28): `npm run authority:drill -- --tracker <id> [--rule FLOOR]` raises a
 * real alarm for one tracker with `payload.drill = true`, to prove the live path end to end (alarm → the trade agent's
 * forced look → its verdict → the escalation runner's answer / owner alert / supreme confirm). A drill NEVER sells:
 *  - the sentinel stores the drill look's EXIT_NOW as EXIT_ADVISORY (the executor polls EXIT_NOW only), no trigger;
 *  - the router refuses any verdict tagged as a drill (DRILL_REASON_TAG) before the executor;
 *  - the escalation runner never backstops, never exits and never shows Exit buttons for a drill alarm: it logs,
 *    tells the owner "DRILL", asks the supreme observe-only, and closes it;
 *  - an owner Exit tap on a drill alarm is refused;
 *  - a drill raise never touches a live alarm, and a real raise supersedes a drill alarm.
 * Pure.
 */

export const DRILL_FLAG = 'drill';

/** Rules a drill may name: never SUPREME_EXIT (its round trip exits through the owner path). */
export const DRILL_RULES: readonly AlarmRule[] = ['FLOOR', 'HARD_LOSS', 'HARD_LOSS_FAST', 'LADDER', 'PRICE_TRIGGER', 'CARRY', 'TARGET_LOCK'];

/** A drill alarm is closed by the runner this long after its raise, answered or not. */
export const DRILL_TTL_MS = 10 * 60_000;

/** ai_exit_executions.reason of a verdict the router refused as a drill. */
export const DRILL_SKIP_REASON = 'DRILL';

/** The advisory tag the sentinel puts in front of a drill look's reason (judge-gate advisoryVerdict). */
export const DRILL_ADVISORY_WHY = 'authority drill';
export const DRILL_REASON_TAG = `[advisory: ${DRILL_ADVISORY_WHY}]`;

/** True for an alarm raised by the drill (`payload.drill === true`). */
export function isDrillAlarm(a: Pick<AlarmRow, 'payload'> | Pick<RaiseAlarm, 'payload'> | null | undefined): boolean {
  return a?.payload?.[DRILL_FLAG] === true;
}

/** True for a verdict reason the sentinel tagged as a drill look. */
export function isDrillReason(reason: string | null | undefined): boolean {
  return String(reason ?? '').trimStart().startsWith(DRILL_REASON_TAG);
}

/** The drill's alarm for a tracker. Urgency is always `normal` (never `deadline`: that arms the deadline backstop). */
export function drillAlarm(
  t: { userId: string; trackerId: string; symbol: string },
  rule: AlarmRule,
  now: Date,
): RaiseAlarm {
  if (!DRILL_RULES.includes(rule)) throw new Error(`a drill may not use rule ${rule} (allowed: ${DRILL_RULES.join(', ')})`);
  return {
    userId: t.userId,
    trackerId: t.trackerId,
    symbol: t.symbol,
    rule,
    urgency: 'normal',
    deadline: null,
    severityN: null,
    reason: `DRILL ${rule}: authority drill, raised ${now.toISOString()}. Judge the position as you normally would; nothing is sold whatever you answer.`,
    wouldHave: 'DRILL (observe only: nothing is sold)',
    sourceRef: `drill:${now.getTime()}`,
    payload: { [DRILL_FLAG]: true, raisedBy: 'authority-drill' },
  };
}

/** One step of the drill path the script prints. */
export interface DrillStep {
  step: 'alarm' | 'look' | 'verdict' | 'execution' | 'answer' | 'owner' | 'confirm' | 'closed';
  at: Date | null;
  detail: string;
}

export interface DrillObservation {
  alarm: Pick<AlarmRow, 'id' | 'rule' | 'status' | 'raisedAt' | 'answeredAt' | 'answer' | 'answerVerdictId' | 'alertedAt' | 'payload'>;
  /** The agent's verdicts on the tracker since the raise, oldest first. */
  verdicts: Array<{ id: string; verdict: string; createdAt: Date; triggeredBy: string[]; reason: string }>;
  /** ai_exit_executions rows of those verdicts. */
  executions: Array<{ verdictId: string; status: string; reason: string | null }>;
}

/** The agent's look that answered the drill: its first verdict after the raise woken by the alarm, else its first. */
export function drillLook(o: Pick<DrillObservation, 'verdicts'>): DrillObservation['verdicts'][number] | null {
  return o.verdicts.find((v) => v.triggeredBy.includes('alarm')) ?? o.verdicts[0] ?? null;
}

/** The path the drill took, as far as it has got (pure, from the rows the script read). */
export function drillPath(o: DrillObservation): DrillStep[] {
  const steps: DrillStep[] = [{ step: 'alarm', at: o.alarm.raisedAt, detail: `${o.alarm.rule} drill alarm ${o.alarm.id} raised (status ${o.alarm.status})` }];
  const look = drillLook(o);
  if (look) {
    steps.push({ step: 'look', at: look.createdAt, detail: `agent looked (triggeredBy ${look.triggeredBy.join(', ') || 'none'})` });
    steps.push({ step: 'verdict', at: look.createdAt, detail: `${look.verdict}: ${look.reason.slice(0, 200)}` });
  }
  for (const e of o.executions) {
    steps.push({ step: 'execution', at: null, detail: `execution row for ${e.verdictId}: ${e.status}${e.reason ? ` ${e.reason}` : ''}` });
  }
  if (o.alarm.answeredAt) steps.push({ step: 'answer', at: o.alarm.answeredAt, detail: `alarm answered ${o.alarm.answer ?? '?'} (verdict ${o.alarm.answerVerdictId ?? '?'})` });
  if (o.alarm.alertedAt) steps.push({ step: 'owner', at: o.alarm.alertedAt, detail: 'owner alerted on Telegram (DRILL, no buttons)' });
  const confirm = o.alarm.payload?.drillConfirm;
  if (typeof confirm === 'string') steps.push({ step: 'confirm', at: null, detail: `supreme confirm (observe only): ${confirm}` });
  if (o.alarm.status === 'CLOSED') steps.push({ step: 'closed', at: null, detail: 'drill alarm closed by the runner' });
  return steps;
}

const SALE_STATUSES = new Set(['CLAIMED', 'PLACED', 'FILLED', 'DRY_RUN']);

/**
 * The drill failed safety when its own look (or any drill-tagged verdict) reached the executor: an execution row
 * that was claimed for a sale (CLAIMED / PLACED / FILLED, or a DRY_RUN rehearsal of one). SKIPPED DRILL is the pass.
 */
export function drillSold(o: Pick<DrillObservation, 'verdicts' | 'executions'>): boolean {
  const look = drillLook(o);
  const drillIds = new Set(o.verdicts.filter((v) => isDrillReason(v.reason) || v.id === look?.id).map((v) => v.id));
  return o.executions.some((e) => drillIds.has(e.verdictId) && SALE_STATUSES.has(e.status));
}
