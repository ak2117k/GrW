import type { DiagnosisMiss, DiagnosisOutput } from '../self-review.ports';
import type { DecisionGradeRowLike } from './decision-loop.ports';
import { actionOf, decisionMiss, mergeMisses, missFacts, nothingGradedReason, shouldAlertNothingGraded, ticketDrafts, ticketKey, wrongItems } from './decision-loop';
import { renderFixQueueMd, sortQueue, type FixTicketRecord } from './fix-queue';

const row = (id: string, over: Partial<DecisionGradeRowLike> = {}): DecisionGradeRowLike => ({
  id, sessionDate: '2026-11-04', decisionType: 'EXIT', detector: null, symbol: 'GOLD25NOV26CE', underlying: 'GOLD', mode: 'live',
  chosen: 'exit at 566.5', alternative: 'hold', pnlChosen: 0, pnlAlternative: 29_850, deltaRupees: 29_850, horizon: '60m', verdict: 'WRONG', reason: 'gated exit', ...over,
});
const legacy = (refId: string): DiagnosisMiss => ({
  sessionDate: '2026-11-04', kind: 'SIGNAL_JUDGE', refId, subject: null, symbol: 'NIFTY', predicted: 'SKIP', actual: 'T1', correct: false, score: 1000, details: null,
});

describe('decision misses', () => {
  it('a ledger row becomes a DECISION:<type> miss scored in ₹ delta', () => {
    expect(decisionMiss(row('g1'))).toMatchObject({ kind: 'DECISION:EXIT', refId: 'dg:g1', score: 29_850, correct: false, sessionDate: '2026-11-04' });
    expect(decisionMiss(row('d1', { decisionType: 'DETECTOR', detector: 'LIVE_NOT_PLACED', deltaRupees: null, reason: '12 risk_manager blocks' }))).toMatchObject({
      kind: 'DECISION:DETECTOR', subject: 'LIVE_NOT_PLACED', score: null,
    });
  });

  it('shares the 15 cap: decisions get 8 slots first, legacy fills, spare slots go back to decisions; detectors rank first', () => {
    const dec = [...Array.from({ length: 12 }, (_, i) => row(`g${i}`, { deltaRupees: 1000 + i })), row('det', { decisionType: 'DETECTOR', detector: 'INPUT_MISSING', deltaRupees: null })];
    const merged = mergeMisses(Array.from({ length: 10 }, (_, i) => legacy(`v${i}`)), dec, 15);
    expect(merged).toHaveLength(15);
    expect(merged.filter((m) => m.kind.startsWith('DECISION:'))).toHaveLength(8);
    expect(merged.some((m) => m.refId === 'dg:det')).toBe(true);
    const few = mergeMisses([legacy('v1')], dec, 15);
    expect(few).toHaveLength(14);
  });
});

describe('fix tickets from the diagnosis', () => {
  const misses = [decisionMiss(row('a', { sessionDate: '2026-11-02', deltaRupees: 600 })), decisionMiss(row('b', { sessionDate: '2026-11-03', deltaRupees: 700 })), decisionMiss(row('c', { deltaRupees: 800 })), decisionMiss(row('z', { deltaRupees: 900 }))];
  const ticket = { title: 'Live orders never placed', proposedChange: 'p', files: ['apps/api/src/modules/risk-manager/risk-manager.service.ts'], testDescription: 't' };
  const diag = (over: Partial<DiagnosisOutput['misses'][number]>): DiagnosisOutput => ({ misses: [{ refIds: ['dg:a', 'dg:b', 'dg:c'], cause: 'why', category: 'OTHER', causeType: 'CODE_BUG', ticket, ...over }] });

  it('an actionable CODE_BUG group yields one ticket keyed by cause + component', () => {
    const [d] = ticketDrafts(diag({}), misses, '2026-11-04');
    expect(d).toMatchObject({ key: 'code-bug:risk-manager-risk-manager-service', cause: 'CODE_BUG', refIds: ['dg:a', 'dg:b', 'dg:c'], costRupees: 2100 });
    expect(d.evidence.sessions).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('a one-off cheap group, a NOISE group or a SETTING group writes no ticket', () => {
    expect(ticketDrafts(diag({ refIds: ['dg:z'] }), misses, '2026-11-04')).toEqual([]);
    expect(ticketDrafts(diag({ causeType: 'NOISE' }), misses, '2026-11-04')).toEqual([]);
    expect(ticketDrafts(diag({ causeType: 'SETTING' }), misses, '2026-11-04')).toEqual([]);
  });

  it('the key is stable across reworded titles when the file is the same', () => {
    expect(ticketKey('CODE_BUG', { title: 'A', files: ['apps/api/src/modules/x/y.ts'] })).toBe(ticketKey('CODE_BUG', { title: 'B totally different', files: ['apps/api/src/modules/x/y.ts'] }));
    expect(ticketKey('DATA', { title: 'GOLD has no futures bars today', files: [] })).toBe('data:gold-has-no-futures-bars-today');
  });

  it('each wrong item says what was decided, the ₹ better, the cause and the action', () => {
    const facts = missFacts(misses);
    const [item] = wrongItems([row('a', { deltaRupees: 600 })], diag({}), facts);
    expect(item).toMatchObject({ refId: 'dg:a', causeType: 'CODE_BUG', cause: 'why', action: 'ticket Live orders never placed' });
    expect(item.better).toContain('₹600');
    expect(actionOf(undefined, facts)).toBe('watching');
    expect(actionOf({ refIds: ['dg:z'], cause: 'c', causeType: 'SETTING', proposalTarget: 'exit.floorTrailN' }, facts)).toBe('proposal exit.floorTrailN');
    expect(actionOf({ refIds: ['dg:z'], cause: 'c', causeType: 'NOISE' }, facts)).toBe('none (noise)');
  });
});

describe('nothing graded', () => {
  it('alerts on a trading day with 0 graded, a failed grading or no grading at all; never on a holiday', () => {
    expect(shouldAlertNothingGraded({ graded: 0, wrong: 0, unscorable: 0, byType: {} }, true, true)).toBe(true);
    expect(shouldAlertNothingGraded({ graded: 0, wrong: 0, unscorable: 0, byType: {}, error: 'db' }, true, true)).toBe(true);
    expect(shouldAlertNothingGraded(null, false, true)).toBe(true);
    expect(shouldAlertNothingGraded({ graded: 4, wrong: 1, unscorable: 0, byType: {} }, true, true)).toBe(false);
    expect(shouldAlertNothingGraded({ graded: 0, wrong: 0, unscorable: 0, byType: {} }, true, false)).toBe(false);
    expect(nothingGradedReason({ graded: 0, wrong: 0, unscorable: 0, byType: {} }, true, false)).toContain('weekend');
    expect(nothingGradedReason({ graded: 3, wrong: 0, unscorable: 0, byType: {} }, true, true)).toBeUndefined();
  });
});

describe('fix queue', () => {
  const t = (key: string, status: string, costRupees: number, lastSeen: string): FixTicketRecord => ({
    id: key, key, cause: 'CODE_BUG', title: `T ${key}`, evidence: { cause: 'because', sessions: ['2026-11-04'] }, proposedChange: 'change it', files: ['a/b.ts'], testDescription: 'test',
    status, occurrences: 2, costRupees, firstSeen: new Date('2026-11-01T00:00:00Z'), lastSeen: new Date(lastSeen),
  });

  it('orders OPEN, then cost, then lastSeen', () => {
    const rows = [t('done', 'DONE', 99_000, '2026-11-04'), t('cheap', 'OPEN', 100, '2026-11-04'), t('old', 'OPEN', 5000, '2026-11-01'), t('new', 'OPEN', 5000, '2026-11-03')];
    expect(sortQueue(rows).map((r) => r.key)).toEqual(['new', 'old', 'cheap', 'done']);
  });

  it('renders markdown with the ticket fields', () => {
    const md = renderFixQueueMd([t('k1', 'OPEN', 12_345, '2026-11-04')], new Date('2026-11-05T00:00:00Z'));
    expect(md).toContain('# Self-review fix queue');
    expect(md).toContain('## [OPEN] T k1');
    expect(md).toContain('₹12,345');
    expect(md).toContain('- files: `a/b.ts`');
    expect(md).toContain('- test: test');
    expect(renderFixQueueMd([])).toContain('No tickets.');
  });
});
