import { ticketKey } from '../tickets/decision-loop';
import {
  decisionGradeId,
  istDate,
  lessonScorecard,
  lessonVerdict,
  missCostRupees,
  missOutcome,
  missTicketKey,
  NOISE_LABEL,
  ONE_OFF_LABEL,
  scorecardRefIds,
  type RefInfo,
  type ScorecardLesson,
  type ScorecardRun,
} from './findings';

const ticket = { title: 'Live orders never placed', proposedChange: 'p', files: ['apps/api/src/modules/risk-manager/risk-manager.service.ts'], testDescription: 't' };
const lessons = new Map([['floor-hard-needs-padverse', { key: 'floor-hard-needs-padverse', status: 'ACTIVE' }]]);
const tKey = ticketKey('CODE_BUG', ticket);
const tickets = new Map([[tKey, { key: tKey, title: 'Live orders never placed', status: 'OPEN' }]]);

describe('missOutcome: what a diagnosed miss became', () => {
  it('a lesson with the exact key', () => {
    expect(missOutcome({ refIds: ['a'], cause: 'c', causeType: 'REASONING', lessonKey: 'floor-hard-needs-padverse' }, lessons, tickets)).toEqual({
      type: 'LESSON', label: 'Lesson: floor-hard-needs-padverse (active)', key: 'floor-hard-needs-padverse', status: 'ACTIVE',
    });
  });
  it('a fix ticket found by the run’s own ticket key (a reworded title on the same file still matches)', () => {
    const m = { refIds: ['dg:1'], cause: 'c', causeType: 'CODE_BUG', ticket: { ...ticket, title: 'Orders blocked by paper count' } };
    expect(missTicketKey(m)).toBe('code-bug:risk-manager-risk-manager-service');
    expect(missOutcome(m, lessons, tickets)).toMatchObject({ type: 'TICKET', label: 'Fix ticket: Live orders never placed (OPEN)', key: tKey });
  });
  it('recorded only when neither the lesson nor the ticket exists; a REASONING group never matches a ticket', () => {
    expect(missOutcome({ refIds: ['a'], cause: 'c', causeType: 'DATA', ticket: { ...ticket, files: ['x/other.ts'] } }, lessons, tickets)).toEqual({ type: 'ONE_OFF', label: ONE_OFF_LABEL });
    expect(missOutcome({ refIds: ['a'], cause: 'c', causeType: 'REASONING', ticket, lessonKey: 'unknown-key' }, lessons, tickets).type).toBe('ONE_OFF');
    expect(ONE_OFF_LABEL).toBe('Recorded only — one-off (needs 3 repeats in 10 sessions or ≥₹5,000)');
  });
  it('noise never acts, by causeType or category', () => {
    expect(missOutcome({ refIds: ['a'], cause: 'c', causeType: 'NOISE', lessonKey: 'floor-hard-needs-padverse' }, lessons, tickets).label).toBe(NOISE_LABEL);
    expect(missOutcome({ refIds: ['a'], cause: 'c', category: 'NOISE' }, lessons, tickets).type).toBe('NOISE');
  });
});

describe('missCostRupees', () => {
  it('sums |₹| of refs with a figure, null when none has one', () => {
    const costs = new Map<string, number | null>([['dg:1', -1200.4], ['dg:2', 800], ['dg:3', null]]);
    expect(missCostRupees(['dg:1', 'dg:2', 'dg:1'], costs)).toBe(2000);
    expect(missCostRupees(['dg:3', 'v:1'], costs)).toBeNull();
    expect(decisionGradeId('dg:abc')).toBe('abc');
    expect(decisionGradeId('2026-11-09:JUBLFOOD')).toBeNull();
  });
});

describe('lessonVerdict (the rule on the page)', () => {
  it('TOO_EARLY under 5 reviewed sessions after', () => {
    expect(lessonVerdict({ beforeSessions: 20, beforeCount: 10, afterSessions: 4, afterCount: 0 })).toBe('TOO_EARLY');
  });
  it('HELPING when the per-session rate at least halves', () => {
    expect(lessonVerdict({ beforeSessions: 10, beforeCount: 4, afterSessions: 5, afterCount: 1 })).toBe('HELPING'); // 0.4 → 0.2
    expect(lessonVerdict({ beforeSessions: 10, beforeCount: 4, afterSessions: 5, afterCount: 0 })).toBe('HELPING');
  });
  it('NOT_HELPING when it is the same, a little lower, higher, or there is no baseline', () => {
    expect(lessonVerdict({ beforeSessions: 10, beforeCount: 4, afterSessions: 5, afterCount: 2 })).toBe('NOT_HELPING'); // 0.4 → 0.4
    expect(lessonVerdict({ beforeSessions: 10, beforeCount: 10, afterSessions: 10, afterCount: 6 })).toBe('NOT_HELPING'); // 1 → 0.6
    expect(lessonVerdict({ beforeSessions: 10, beforeCount: 1, afterSessions: 5, afterCount: 3 })).toBe('NOT_HELPING');
    expect(lessonVerdict({ beforeSessions: 0, beforeCount: 0, afterSessions: 8, afterCount: 0 })).toBe('NOT_HELPING');
  });
});

describe('lessonScorecard', () => {
  const diag = (misses: unknown[]) => ({ misses });
  const lesson = (key: string, firstSeen: string, over: Partial<ScorecardLesson> = {}): ScorecardLesson => ({
    id: key, key, text: `t ${key}`, scope: 'ALL', status: 'ACTIVE', firstSeen, rightCount: 1, wrongCount: 0, ...over,
  });

  it('istDate: a 00:30 IST run (19:00 UTC the day before) is the next IST day', () => {
    expect(istDate('2026-11-04T19:00:00Z')).toBe('2026-11-05');
  });

  it('dedupes a refId across runs and nights, places it in its own session, normalises per reviewed session', () => {
    const runs: ScorecardRun[] = [
      { sessionDate: '2026-11-02', diagnosis: diag([{ refIds: ['dg:a'], cause: 'c', lessonKey: 'k' }]) },
      // the 02:30 run of the same night repeats the refId
      { sessionDate: '2026-11-02', diagnosis: diag([{ refIds: ['dg:a'], cause: 'c', lessonKey: 'k' }]) },
      { sessionDate: '2026-11-03', diagnosis: diag([{ refIds: ['v:1'], cause: 'c', lessonKey: 'k' }]) },
      // the lesson went active on 11-04 (00:30 IST); the 11-05 night re-diagnoses dg:a (a 11-02 decision) → still before
      { sessionDate: '2026-11-04', diagnosis: diag([]) },
      { sessionDate: '2026-11-05', diagnosis: diag([{ refIds: ['dg:a', 'dg:b'], cause: 'c', lessonKey: 'k' }]) },
      { sessionDate: '2026-11-06', diagnosis: diag([]) },
      { sessionDate: '2026-11-07', diagnosis: null }, // no diagnosis: not a reviewed session
    ];
    const refs = new Map<string, RefInfo>([
      ['dg:a', { sessionDate: '2026-11-02', costRupees: -3000 }],
      ['dg:b', { sessionDate: '2026-11-05', costRupees: 1000 }],
      ['v:1', { sessionDate: '2026-11-03', costRupees: null }],
    ]);
    expect(scorecardRefIds(runs).sort()).toEqual(['dg:a', 'dg:b', 'v:1']);
    const card = lessonScorecard(runs, [lesson('k', '2026-11-03T19:00:00Z')], refs);
    expect(card.reviewedSessions).toBe(5);
    const [s] = card.lessons;
    expect(s.activeSince).toBe('2026-11-04');
    expect(s.before).toEqual({ sessions: 2, mistakes: 2, perSession: 1, costRupees: 3000, costUnknown: 1, costPerSession: 1500 });
    expect(s.after).toEqual({ sessions: 3, mistakes: 1, perSession: 0.33, costRupees: 1000, costUnknown: 0, costPerSession: 333 });
    expect(s.verdict).toBe('TOO_EARLY');
  });

  it('a lesson with no mistakes after 5+ sessions is HELPING; one repeating as often is NOT_HELPING; ACTIVE before RETIRED', () => {
    const sessions = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
    const runs: ScorecardRun[] = sessions.map((s, i) => ({
      sessionDate: s,
      diagnosis: diag([
        ...(i < 4 ? [{ refIds: [`h${i}`], cause: 'c', lessonKey: 'helps' }] : []),
        { refIds: [`n${i}`], cause: 'c', lessonKey: 'nohelp' },
      ]),
    }));
    const card = lessonScorecard(runs, [lesson('old', '2026-10-01T00:00:00Z', { status: 'RETIRED' }), lesson('helps', '2026-10-30T19:00:00Z'), lesson('nohelp', '2026-10-30T19:00:00Z')], new Map());
    const by = Object.fromEntries(card.lessons.map((l) => [l.key, l]));
    expect(by.helps.before.sessions).toBe(4);
    expect(by.helps.after.sessions).toBe(6);
    expect(by.helps.verdict).toBe('HELPING');
    expect(by.nohelp.verdict).toBe('NOT_HELPING');
    expect(by.helps.before.costUnknown).toBe(4);
    expect(card.lessons.map((l) => l.key)).toEqual(['nohelp', 'helps', 'old']);
    expect(card.rule).toContain('TOO_EARLY until 5 reviewed sessions');
  });
});
