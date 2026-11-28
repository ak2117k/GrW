import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isPaperTracker } from '../../trade-sentinel/paper/paper-tracker';
import { shouldReRaise } from '../domain/alarm';
import { isDrillAlarm } from '../domain/drill';
import {
  AUTHORITY_STATE,
  TRACKER_WAKE,
  type AlarmRow,
  type AuthorityStatePort,
  type RaiseAlarm,
  type TrackerWakePort,
  type TradeAlarmsPort,
} from '../exit-authority.tokens';
import { TradeAlarmRepository } from '../repositories/trade-alarm.repository';

export const ALARM_REASON_CAP = 500;

/**
 * The alarm store's front door. A code rule that would have sold calls raise(); the alarm is persisted
 * (one open alarm per (tracker, rule), re-raised only per shouldReRaise) and the tracker's agent is woken.
 *
 * Inert unless the exit authority is live (AUTHORITY_STATE bound and isLive()), and never for paper trackers,
 * so with TRADE_AGENT_AUTHORITY=off nothing is written and nothing is woken.
 */
@Injectable()
export class TradeAlarmsService implements TradeAlarmsPort {
  private readonly log = new Logger(TradeAlarmsService.name);
  private warnedNoWake = false;
  /** Tail of the in-flight raise chain per (tracker, rule). */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: TradeAlarmRepository,
    @Optional() @Inject(TRACKER_WAKE) private readonly wake?: TrackerWakePort,
    @Optional() @Inject(AUTHORITY_STATE) private readonly state?: AuthorityStatePort,
  ) {}

  async raise(a: RaiseAlarm, now: Date = new Date()): Promise<AlarmRow | null> {
    if (isPaperTracker(a.trackerId)) return null;
    if (!this.state?.isLive()) return null;

    // Serialise raises per (tracker, rule) in-process, so a tick-driven rule and a sentinel pass firing together
    // never both read "no alarm" and both create. Across processes the partial unique index backs this up (P2002).
    const key = `${a.trackerId}\u0000${a.rule}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.raiseSerial(a, now));
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private async raiseSerial(a: RaiseAlarm, now: Date): Promise<AlarmRow | null> {
    const reason = (a.reason ?? '').slice(0, ALARM_REASON_CAP);
    let latest = await this.repo.findLatestLive(a.trackerId, a.rule);

    // Authority drill (domain/drill.ts): a drill never refreshes or flags a REAL live alarm (that would make the real
    // alarm observe-only), and a real raise never waits on a drill: the drill row is closed and a fresh real alarm made.
    if (isDrillAlarm(a) && latest && !isDrillAlarm(latest)) {
      this.log.log(`[exit-authority] DRILL ${a.rule} on ${a.trackerId} refused: a real ${a.rule} alarm (${latest.id}) is live`);
      return null;
    }
    if (!isDrillAlarm(a) && latest && isDrillAlarm(latest)) {
      await this.repo.update(latest.id, { status: 'CLOSED' });
      this.log.log(`[exit-authority] drill alarm ${latest.id} closed: a real ${a.rule} alarm supersedes it on ${a.trackerId}`);
      latest = null;
    }

    // A deadline is never lost: a raise without one (e.g. the router's CARRY alarm from a rule EXIT_NOW) keeps the
    // deadline (and the `deadline` urgency, which arms the broker-deadline backstop) of the alarm it refreshes/follows.
    const inherit = latest != null && latest.deadline != null && a.deadline == null;
    const deadline = inherit ? latest!.deadline : a.deadline ?? null;
    const urgency = inherit && latest!.urgency === 'deadline' ? 'deadline' : a.urgency;

    let row: AlarmRow;
    if (latest && !shouldReRaise(latest, a, now)) {
      return null;
    } else if (latest && latest.status !== 'ANSWERED') {
      // Still open (or a snooze that ran out): refresh the same row rather than stacking a second one.
      row = await this.repo.update(latest.id, {
        status: 'OPEN',
        snoozedUntil: null,
        lastRaisedAt: now,
        severityN: a.severityN ?? null,
        reason,
        wouldHave: a.wouldHave,
        urgency,
        deadline,
        sourceRef: a.sourceRef ?? null,
        payload: a.payload,
        symbol: a.symbol,
      });
    } else {
      // Nothing live, or the agent answered and the rule is still true past the re-raise rule: a fresh alarm.
      const created = await this.createOrDedupe({
        userId: a.userId,
        trackerId: a.trackerId,
        symbol: a.symbol,
        rule: a.rule,
        urgency,
        reason,
        wouldHave: a.wouldHave,
        deadline,
        severityN: a.severityN ?? null,
        sourceRef: a.sourceRef ?? null,
        payload: a.payload,
        status: 'OPEN',
        raisedAt: now,
        lastRaisedAt: now,
        answeredAt: null,
        answerVerdictId: null,
        answer: null,
        alertedAt: null,
        alertCount: 0,
        telegramMessageId: null,
        snoozedUntil: null,
      });
      if (!created) return null;
      row = created;
    }

    this.wakeAgent(row);
    return row;
  }

  /** Create, or null when another process already holds the live alarm (partial unique index → P2002). */
  private async createOrDedupe(input: Omit<AlarmRow, 'id'>): Promise<AlarmRow | null> {
    try {
      return await this.repo.create(input);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') {
        this.log.log(`[exit-authority] raise deduped by unique index: ${input.trackerId} ${input.rule}`);
        return null;
      }
      throw err;
    }
  }

  openFor(trackerId: string): Promise<AlarmRow[]> {
    return this.repo.findOpen(trackerId);
  }

  async openForTrackers(trackerIds: string[]): Promise<AlarmRow[]> {
    if (trackerIds.length === 0) return [];
    return this.repo.findOpenForTrackers(trackerIds);
  }

  /**
   * Conditional (WHERE status IN OPEN/SNOOZED): an answer that arrives after the runner backstopped / closed the
   * alarm, or after another answer, changes nothing (never resurrects a BACKSTOPPED / CLOSED row).
   */
  async answer(alarmId: string, verdictId: string, answer: string, now: Date = new Date()): Promise<void> {
    const done = await this.repo.answerIfOpen(alarmId, { answeredAt: now, answerVerdictId: verdictId, answer });
    if (!done) this.log.log(`[exit-authority] alarm ${alarmId} no longer open: answer ${answer} (verdict ${verdictId}) not applied`);
  }

  /** Best effort: the alarm is already persisted, so a failed wake is caught by the next pass / escalation. */
  private wakeAgent(row: AlarmRow): void {
    if (!this.wake) {
      if (!this.warnedNoWake) {
        this.warnedNoWake = true;
        this.log.warn('[exit-authority] TRACKER_WAKE not bound: alarms are stored but no agent is woken');
      }
      return;
    }
    try {
      this.wake.wakeTracker(row.userId, row.trackerId, `alarm ${row.rule}`);
    } catch (err) {
      this.log.error(`[exit-authority] wakeTracker failed for ${row.trackerId} (${row.rule}): ${(err as Error).message}`);
    }
  }
}
