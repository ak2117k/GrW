import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isPaperTracker } from '../../trade-sentinel/paper/paper-tracker';
import { shouldReRaise } from '../domain/alarm';
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
    const latest = await this.repo.findLatestLive(a.trackerId, a.rule);

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
        urgency: a.urgency,
        deadline: a.deadline ?? null,
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
        urgency: a.urgency,
        reason,
        wouldHave: a.wouldHave,
        deadline: a.deadline ?? null,
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

  async answer(alarmId: string, verdictId: string, answer: string, now: Date = new Date()): Promise<void> {
    await this.repo.update(alarmId, {
      status: 'ANSWERED',
      answeredAt: now,
      answerVerdictId: verdictId,
      answer,
    });
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
