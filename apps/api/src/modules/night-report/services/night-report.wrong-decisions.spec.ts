import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NightReportStore } from '../repositories/night-report.repository';
import { wrongDecisionsView } from '../domain/wrong-decisions';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-11-05T02:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const store: NightReportStore = {
  openTrackers: async () => [],
  cashTokens: async () => new Map(),
  verdictsSince: async () => [],
  newsPublishedBetween: async () => [],
  eventsBetween: async () => [],
  dailySignalsOn: async () => [],
  newestNewsFetchedAt: async () => null,
  dailyCandles: async () => ({ newest: null, countAtDay: 0 }),
  newestMbmPredictionAt: async () => null,
  newestMbmChainAt: async () => null,
  mbmChainCaptures: async () => [],
  mbmPredictionsBetween: async () => [],
  lastOvernightReviewAt: async () => null,
};
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };

const latest = (decisions: unknown) => ({ run: { id: 'r1' }, summary: { session: '2026-11-04', decisions }, misses: [], lessonsAdded: [], proposalsPending: 0 });
const item = (over: Record<string, unknown> = {}) => ({
  refId: 'dg:1', decided: 'EXIT exit at 566.5 (GOLD25NOV26CE, live)', better: 'hold would have made ₹29,850 more per lot, net (60m)', deltaRupees: 29_850,
  causeType: 'SETTING', cause: 'the floor trail is too tight on GOLD', action: 'proposal exit.floorTrailN', symbol: 'GOLD25NOV26CE', mode: 'live', ...over,
});

describe('night report — Wrong decisions', () => {
  it('always shows graded / wrong / unscorable, each item in plain words, and an applied setting as the action', () => {
    const v = wrongDecisionsView(
      latest({ session: '2026-11-04', graded: 31, wrong: 2, unscorable: 3, items: [item(), item({ refId: 'dg:2', causeType: 'CODE_BUG', action: 'ticket Live orders never placed' })], tickets: [{ key: 'code-bug:x', title: 'Live orders never placed', occurrences: 4, status: 'OPEN' }] }),
      [{ target: 'exit.floorTrailN', kind: 'APPLY', from: 2, to: 2.25, session: '2026-11-04' }, { target: 'carry.decideByMin', kind: 'ROLLBACK', from: 6, to: 5, session: '2026-11-04', reason: 'worse after 3 sessions' }],
    );
    expect(v?.line).toBe('graded 31, wrong 2, unscorable 3');
    expect(v?.items[0].action).toBe('applied exit.floorTrailN 2→2.25');
    expect(v?.items[0].text).toBe('Decided EXIT exit at 566.5 (GOLD25NOV26CE, live); better: hold would have made ₹29,850 more per lot, net (60m). Cause: SETTING — the floor trail is too tight on GOLD. Action: applied exit.floorTrailN 2→2.25.');
    expect(v?.items[1].action).toBe('ticket Live orders never placed');
    expect(v?.changes).toEqual(['applied exit.floorTrailN 2 → 2.25 (2026-11-04)', 'rolled back carry.decideByMin 6 → 5 (2026-11-04) — worse after 3 sessions']);
    expect(v?.tickets).toHaveLength(1);
  });

  it('0 graded says so with the reason; graded with 0 wrong says "0 wrong decisions found"', () => {
    expect(wrongDecisionsView(latest({ session: '2026-11-04', graded: 0, wrong: 0, unscorable: 0, reason: 'no NSE session today (weekend / holiday)', items: [] }))?.line).toBe(
      'graded 0, wrong 0, unscorable 0 — no NSE session today (weekend / holiday)',
    );
    expect(wrongDecisionsView(latest({ session: '2026-11-04', graded: 12, wrong: 0, unscorable: 1, items: [] }))?.line).toBe('graded 12, wrong 0, unscorable 1 — 0 wrong decisions found');
  });

  it('null when the run has no decisions block (loop off / older run)', () => {
    expect(wrongDecisionsView(latest(undefined))).toBeNull();
    expect(wrongDecisionsView(null)).toBeNull();
  });

  it('the service builds the section from the self-review latest + the applied changes since its session; changes failing costs only the list', async () => {
    const recentChanges = jest.fn(async () => [{ target: 'exit.floorTrailN', kind: 'APPLY', from: 2, to: 2.25, session: '2026-11-04' }]);
    const src = { latest: async () => latest({ session: '2026-11-04', graded: 5, wrong: 1, unscorable: 0, items: [item()] }) };
    const svc = new NightReportService(store, mood, { clock, hold: [] }, undefined, src, undefined, undefined, undefined, undefined, { recentChanges });
    const r = await svc.build('u1', NOW);
    expect(recentChanges).toHaveBeenCalledWith('2026-11-04');
    expect(r.wrongDecisions).toMatchObject({ line: 'graded 5, wrong 1, unscorable 0', items: [{ action: 'applied exit.floorTrailN 2→2.25' }] });

    const broken = new NightReportService(store, mood, { clock, hold: [] }, undefined, src, undefined, undefined, undefined, undefined, { recentChanges: async () => { throw new Error('db'); } });
    expect((await broken.build('u1', NOW)).wrongDecisions).toMatchObject({ items: [{ action: 'proposal exit.floorTrailN' }], changes: [] });
    expect((await new NightReportService(store, mood, { clock, hold: [] }).build('u1', NOW)).wrongDecisions).toBeNull();
  });
});
