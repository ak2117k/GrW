import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import type { LifecycleEvent } from '../lifecycle/lifecycle.types';
import { JournalLifecycleSink, JournalRiskVerdictSink, STOP_MOVED_COALESCE_MS } from './journal-sinks';
import { FakeJournal } from './testing/fake-journal';

const T0 = new Date('2026-10-13T05:00:00.000Z');
const ev = (type: LifecycleEvent['type'], payload: Record<string, unknown>, atMs = 0, positionId = 'pos_1'): LifecycleEvent => ({
  type, userId: 'user_A', positionId, strategyVersionId: 'csv_x', payload, priceUsed: 500, priceAgeMs: 12, at: new Date(T0.getTime() + atMs),
});

describe('JournalLifecycleSink (L12 rebound; J15, J16)', () => {
  it('writes each lifecycle event as a journal row with its price and age', async () => {
    const j = new FakeJournal();
    await new JournalLifecycleSink(j).record(ev('EXIT_DECIDED', { reason: 'STOP' }));
    expect(j.entries).toEqual([{ type: 'EXIT_DECIDED', userId: 'user_A', at: T0, positionId: 'pos_1', strategyVersionId: 'csv_x', payload: { reason: 'STOP' }, priceUsed: 500, priceAgeMs: 12 }]);
  });

  it('coalesces trailing stop moves to one per 30 s per position; the newest held move is written before the next other event', async () => {
    const j = new FakeJournal();
    const sink = new JournalLifecycleSink(j);
    await sink.record(ev('STOP_MOVED', { from: 490, to: 491, why: 'TRAIL' }, 0));
    await sink.record(ev('STOP_MOVED', { from: 491, to: 492, why: 'TRAIL' }, 1_000));
    await sink.record(ev('STOP_MOVED', { from: 492, to: 493, why: 'TRAIL' }, 2_000));
    await sink.record(ev('STOP_MOVED', { from: 0, to: 600, why: 'TRAIL' }, 3_000, 'pos_2'));
    expect(j.entries.map((x) => [x.positionId, x.payload.to])).toEqual([['pos_1', 491], ['pos_2', 600]]);
    await sink.record(ev('EXIT_DECIDED', { reason: 'TRAIL' }, 4_000));
    expect(j.entries.map((x) => [x.type, x.payload.to ?? x.payload.reason])).toEqual([['STOP_MOVED', 491], ['STOP_MOVED', 600], ['STOP_MOVED', 493], ['EXIT_DECIDED', 'TRAIL']]);
    await sink.record(ev('STOP_MOVED', { from: 493, to: 494, why: 'TRAIL' }, 3_000 + STOP_MOVED_COALESCE_MS));
    expect(j.entries[j.entries.length - 1].payload.to).toBe(494);
  });

  it('a guard-rail stop move is never coalesced', async () => {
    const j = new FakeJournal();
    const sink = new JournalLifecycleSink(j);
    await sink.record(ev('STOP_MOVED', { from: 490, to: 491, why: 'TRAIL' }, 0));
    await sink.record(ev('STOP_MOVED', { source: 'sentinel', from: 491, to: 495, why: 'GUARD_RAIL', accepted: true }, 1_000));
    expect(j.entries.map((x) => x.payload.to)).toEqual([491, 495]);
  });

  it('a close tells the summary writer; its failure is logged and never thrown', async () => {
    const j = new FakeJournal();
    const closed = { positionClosed: jest.fn().mockRejectedValueOnce(new Error('summary db down')).mockResolvedValue(undefined) };
    const sink = new JournalLifecycleSink(j, closed);
    await expect(sink.record(ev('POSITION_STATE', { from: 'EXITING', to: 'CLOSED' }))).resolves.toBeUndefined();
    await sink.record(ev('POSITION_STATE', { from: 'PENDING_ENTRY', to: 'CANCELLED' }, 0, 'pos_2'));
    expect(closed.positionClosed).toHaveBeenCalledTimes(1);
    expect(closed.positionClosed).toHaveBeenCalledWith('user_A', 'pos_1');
  });
});

describe('JournalRiskVerdictSink (M2 RISK_VERDICT_SINK rebound; J10, J13)', () => {
  const verdict = (over: Partial<RiskVerdict> = {}): RiskVerdict => ({
    intentId: 'ci_1', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW', requestedQty: 10, qty: 10, reasons: [{ code: 'WITHIN_LIMITS', message: 'ok' }],
    limits: limitsFixture(), state: null, dailyLoss: null, killSwitchActive: false, checkedAt: T0.toISOString(), ...over,
  });

  it('writes the whole verdict (limits snapshot included) durably', async () => {
    const j = new FakeJournal();
    await new JournalRiskVerdictSink(j).record(verdict());
    expect(j.entries).toEqual([expect.objectContaining({ type: 'RISK_VERDICT', userId: 'user_A', intentId: 'ci_1', at: T0, payload: expect.objectContaining({ limits: limitsFixture() }) })]);
  });

  it('a verdict that cannot be recorded throws to the wall (which then rejects the entry: JOURNAL_UNAVAILABLE)', async () => {
    const j = new FakeJournal();
    j.failNow = true;
    await expect(new JournalRiskVerdictSink(j).record(verdict())).rejects.toThrow('journal down');
  });

  it('an EXIT verdict is written best effort: a journal outage never delays or fails the exit (Global Constraints)', async () => {
    const j = new FakeJournal();
    j.failNow = true;
    const recordNow = jest.spyOn(j, 'recordNow');
    await expect(new JournalRiskVerdictSink(j).record(verdict({ intentKind: 'EXIT', limits: [] }))).resolves.toBeUndefined();
    expect(recordNow).not.toHaveBeenCalled();
    expect(j.entries).toEqual([expect.objectContaining({ type: 'RISK_VERDICT', intentId: 'ci_1', payload: expect.objectContaining({ intentKind: 'EXIT' }) })]);
  });

  it('a DAILY_LOSS rejection also latches the day (idempotent per user and IST day)', async () => {
    const j = new FakeJournal();
    const dailyLoss = { status: 'BREACHED' as const, lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES' as const, squareOffCore: false };
    await new JournalRiskVerdictSink(j).record(verdict({ verdict: 'REJECT', qty: 0, reasons: [{ code: 'DAILY_LOSS', message: 'x' }], dailyLoss }));
    expect(j.ofType('DAILY_LOSS_LATCHED')).toEqual([
      expect.objectContaining({ dedupeKey: 'latch:user_A:2026-10-13', payload: { day: '2026-10-13', source: 'RISK_VERDICT', lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES' } }),
    ]);
  });
});
