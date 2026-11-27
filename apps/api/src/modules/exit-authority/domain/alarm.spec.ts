import type { AlarmRow, RaiseAlarm } from '../exit-authority.tokens';
import { backstopDue, escalationDue, shouldReRaise } from './alarm';
import {
  BACKSTOP_OWNER_SILENT_MS,
  DEADLINE_EXIT_LEAD_MS,
  DEADLINE_WARN_MS,
  ESCALATE_AFTER_MS,
  ESCALATE_URGENT_AFTER_MS,
  REALARM_EVERY_MS,
  REALARM_URGENT_EVERY_MS,
  REALERT_EVERY_MS,
} from './timings';

const T0 = new Date('2026-11-27T05:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function row(over: Partial<AlarmRow> = {}): AlarmRow {
  return {
    id: 'a1',
    userId: 'u1',
    trackerId: 't1',
    symbol: 'NIFTY25DEC26000CE',
    rule: 'FLOOR',
    urgency: 'normal',
    reason: 'floor broken',
    wouldHave: 'EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED',
    deadline: null,
    severityN: 0.5,
    sourceRef: null,
    payload: {},
    status: 'OPEN',
    raisedAt: T0,
    lastRaisedAt: T0,
    answeredAt: null,
    answerVerdictId: null,
    answer: null,
    alertedAt: null,
    alertCount: 0,
    telegramMessageId: null,
    snoozedUntil: null,
    ...over,
  };
}

function next(over: Partial<RaiseAlarm> = {}): RaiseAlarm {
  return {
    userId: 'u1',
    trackerId: 't1',
    symbol: 'NIFTY25DEC26000CE',
    rule: 'FLOOR',
    urgency: 'normal',
    reason: 'floor broken',
    wouldHave: 'EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED',
    severityN: 0.9,
    ...over,
  };
}

describe('shouldReRaise', () => {
  it('is false 30 s after the open alarm when less than 1 N15 worse', () => {
    expect(shouldReRaise(row(), next({ severityN: 1.4 }), at(30_000))).toBe(false);
  });

  it('is true at >= 1 N15 worse', () => {
    expect(shouldReRaise(row(), next({ severityN: 1.5 }), at(30_000))).toBe(true);
  });

  it('is false when severity is unknown on either side and the interval has not passed', () => {
    expect(shouldReRaise(row({ severityN: null }), next({ severityN: 5 }), at(30_000))).toBe(false);
    expect(shouldReRaise(row(), next({ severityN: null }), at(30_000))).toBe(false);
  });

  it('is true after REALARM_EVERY_MS for a normal alarm, not before', () => {
    expect(shouldReRaise(row(), next({ severityN: 0.5 }), at(REALARM_EVERY_MS - 1))).toBe(false);
    expect(shouldReRaise(row(), next({ severityN: 0.5 }), at(REALARM_EVERY_MS))).toBe(true);
  });

  it('is true after REALARM_URGENT_EVERY_MS for an urgent alarm', () => {
    const open = row({ urgency: 'urgent', rule: 'HARD_LOSS' });
    const n = next({ urgency: 'urgent', rule: 'HARD_LOSS', severityN: 0.5 });
    expect(shouldReRaise(open, n, at(REALARM_URGENT_EVERY_MS - 1))).toBe(false);
    expect(shouldReRaise(open, n, at(REALARM_URGENT_EVERY_MS))).toBe(true);
  });

  it('measures the interval from lastRaisedAt, not raisedAt', () => {
    const open = row({ lastRaisedAt: at(200_000) });
    expect(shouldReRaise(open, next({ severityN: 0.5 }), at(REALARM_EVERY_MS + 1))).toBe(false);
  });

  it('measures the interval from the agent answer when that is later than the last raise', () => {
    const answered = row({ status: 'ANSWERED', answeredAt: at(200_000), answerVerdictId: 'v1', answer: 'HOLD' });
    expect(shouldReRaise(answered, next({ severityN: 0.5 }), at(REALARM_EVERY_MS + 1))).toBe(false);
    expect(shouldReRaise(answered, next({ severityN: 0.5 }), at(200_000 + REALARM_EVERY_MS))).toBe(true);
    // still re-raised at once when ≥ 1 N15 worse
    expect(shouldReRaise(answered, next({ severityN: 1.5 }), at(210_000))).toBe(true);
  });

  it('is false while SNOOZED, even when much worse or overdue', () => {
    const open = row({ status: 'SNOOZED', snoozedUntil: at(900_000) });
    expect(shouldReRaise(open, next({ severityN: 9 }), at(REALARM_EVERY_MS + 1))).toBe(false);
  });

  it('applies again once the snooze has expired', () => {
    const open = row({ status: 'SNOOZED', snoozedUntil: at(60_000) });
    expect(shouldReRaise(open, next({ severityN: 2 }), at(61_000))).toBe(true);
  });
});

describe('escalationDue', () => {
  it('is ALERT once a normal alarm is unanswered for ESCALATE_AFTER_MS with no alert yet', () => {
    expect(escalationDue(row(), at(ESCALATE_AFTER_MS - 1))).toBeNull();
    expect(escalationDue(row(), at(ESCALATE_AFTER_MS))).toBe('ALERT');
  });

  it('is ALERT after 60 s for an urgent alarm', () => {
    const a = row({ urgency: 'urgent', rule: 'HARD_LOSS' });
    expect(ESCALATE_URGENT_AFTER_MS).toBe(60_000);
    expect(escalationDue(a, at(ESCALATE_URGENT_AFTER_MS - 1))).toBeNull();
    expect(escalationDue(a, at(ESCALATE_URGENT_AFTER_MS))).toBe('ALERT');
  });

  it('is REALERT when the last alert is REALERT_EVERY_MS old', () => {
    const a = row({ alertedAt: at(ESCALATE_AFTER_MS), alertCount: 1 });
    expect(escalationDue(a, at(ESCALATE_AFTER_MS + REALERT_EVERY_MS - 1))).toBeNull();
    expect(escalationDue(a, at(ESCALATE_AFTER_MS + REALERT_EVERY_MS))).toBe('REALERT');
  });

  it('is DEADLINE_WARN when the deadline is within DEADLINE_WARN_MS and no alert yet', () => {
    const a = row({ urgency: 'deadline', rule: 'CARRY', deadline: at(DEADLINE_WARN_MS + 5_000) });
    expect(escalationDue(a, at(4_000))).toBeNull();
    expect(escalationDue(a, at(5_000))).toBe('DEADLINE_WARN');
  });

  it('is null when ANSWERED', () => {
    const a = row({ status: 'ANSWERED', answeredAt: at(10_000), answerVerdictId: 'v1', answer: 'HOLD' });
    expect(escalationDue(a, at(ESCALATE_AFTER_MS * 5))).toBeNull();
  });

  it('is null for BACKSTOPPED, CLOSED and a live snooze', () => {
    expect(escalationDue(row({ status: 'BACKSTOPPED' }), at(ESCALATE_AFTER_MS))).toBeNull();
    expect(escalationDue(row({ status: 'CLOSED' }), at(ESCALATE_AFTER_MS))).toBeNull();
    expect(escalationDue(row({ status: 'SNOOZED', snoozedUntil: at(ESCALATE_AFTER_MS + 1) }), at(ESCALATE_AFTER_MS))).toBeNull();
  });
});

describe('backstopDue', () => {
  const quiet = { aiDown: false, stillPastLimit: true };

  it('is DEADLINE at deadline - DEADLINE_EXIT_LEAD_MS for an unanswered deadline alarm', () => {
    const a = row({ urgency: 'deadline', rule: 'CARRY', deadline: at(DEADLINE_EXIT_LEAD_MS + 10_000) });
    expect(backstopDue(a, quiet, at(9_999))).toBeNull();
    expect(backstopDue(a, quiet, at(10_000))).toBe('DEADLINE');
  });

  describe('owner ruling 2026-11-27: an agent HOLD does not disarm the deadline backstop', () => {
    const answered = row({
      urgency: 'deadline',
      rule: 'CARRY',
      deadline: at(DEADLINE_EXIT_LEAD_MS + 10_000),
      status: 'ANSWERED',
      answeredAt: at(1),
      answerVerdictId: 'v1',
      answer: 'HOLD',
    });

    it('answered HOLD → still DEADLINE at deadline − 2 min (not before)', () => {
      expect(backstopDue(answered, quiet, at(9_999))).toBeNull();
      expect(backstopDue(answered, quiet, at(10_000))).toBe('DEADLINE');
    });

    it('converted to carry (product no longer intraday) → no backstop, answered or not', () => {
      expect(backstopDue(answered, { ...quiet, stillIntraday: false }, at(10_000))).toBeNull();
      expect(backstopDue({ ...answered, status: 'OPEN', answeredAt: null }, { ...quiet, stillIntraday: false }, at(10_000))).toBeNull();
    });

    it('a closed / backstopped alarm (tracker closed) → no backstop', () => {
      expect(backstopDue({ ...answered, status: 'CLOSED' }, quiet, at(10_000))).toBeNull();
      expect(backstopDue({ ...answered, status: 'BACKSTOPPED' }, quiet, at(10_000))).toBeNull();
    });

    it('a running owner Hold snooze still holds it', () => {
      expect(backstopDue({ ...answered, status: 'SNOOZED', answeredAt: null, snoozedUntil: at(20_000) }, quiet, at(10_000))).toBeNull();
    });
  });

  describe('HARD_LOSS', () => {
    // Raised at T0, alert sent at 60 s; owner silent 10 min after that.
    const alerted = at(ESCALATE_URGENT_AFTER_MS);
    const due = at(ESCALATE_URGENT_AFTER_MS + BACKSTOP_OWNER_SILENT_MS);
    const hard = (over: Partial<AlarmRow> = {}): AlarmRow =>
      row({ rule: 'HARD_LOSS', urgency: 'urgent', alertedAt: alerted, alertCount: 1, ...over });

    it('is HARD_LOSS when the agent is silent past ESCALATE_URGENT_AFTER_MS, owner silent 10 min, still past limit', () => {
      expect(backstopDue(hard(), quiet, due)).toBe('HARD_LOSS');
      expect(backstopDue(hard({ rule: 'HARD_LOSS_FAST' }), quiet, due)).toBe('HARD_LOSS');
    });

    it('is HARD_LOSS when AI is down even if the alarm is young', () => {
      const young = hard({ raisedAt: at(due.getTime() - T0.getTime() - 1_000), alertedAt: alerted });
      expect(backstopDue(young, { aiDown: true, stillPastLimit: true }, due)).toBe('HARD_LOSS');
      expect(backstopDue(young, { aiDown: false, stillPastLimit: true }, due)).toBeNull();
    });

    it('is null when the owner alert is not yet BACKSTOP_OWNER_SILENT_MS old', () => {
      expect(backstopDue(hard(), quiet, at(due.getTime() - T0.getTime() - 1))).toBeNull();
    });

    it('is null when no alert was ever sent', () => {
      expect(backstopDue(hard({ alertedAt: null, alertCount: 0 }), quiet, due)).toBeNull();
    });

    it('is null when no longer past the limit', () => {
      expect(backstopDue(hard(), { aiDown: true, stillPastLimit: false }, due)).toBeNull();
    });

    it('is null for any other rule', () => {
      expect(backstopDue(hard({ rule: 'FLOOR' }), quiet, due)).toBeNull();
      expect(backstopDue(hard({ rule: 'SUPREME_EXIT' }), quiet, due)).toBeNull();
    });

    it('is null when answered', () => {
      expect(backstopDue(hard({ status: 'ANSWERED', answeredAt: at(1), answerVerdictId: 'v', answer: 'HOLD' }), quiet, due)).toBeNull();
    });

    it('is null while SNOOZED (owner said Hold)', () => {
      expect(backstopDue(hard({ status: 'SNOOZED', snoozedUntil: at(due.getTime() - T0.getTime() + 1) }), quiet, due)).toBeNull();
    });
  });
});
