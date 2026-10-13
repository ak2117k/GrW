import { estimateCharges } from '../../trade-sentinel/charges';
import { BROKER_CORPUS_SOURCE, BROKER_TRADE_KIND, BROKER_VERDICTS_MAX, brokerTradeRecord, type TrackerRow, type VerdictRow } from './broker-corpus';

const ENTRY = new Date('2026-10-13T04:00:00.000Z'); // 09:30 IST
const EXIT = new Date('2026-10-13T05:30:00.000Z'); // 11:00 IST
const tracker = (over: Partial<TrackerRow> = {}): TrackerRow => ({
  id: 'trk_1', userId: 'user_A', symbol: 'NIFTY14OCT2525000CE', exchange: 'NFO', token: '45000', kind: 'POSITION',
  entryPrice: 100, qty: 75, entryTime: ENTRY, exitPrice: 120, exitTime: EXIT, status: 'CLOSED', holdingHigh: 130, holdingLow: 90,
  ...over,
});
const verdict = (at: Date, v = 'HOLD', over: Partial<VerdictRow> = {}): VerdictRow => ({
  id: `sv_${at.getTime()}`, createdAt: at, verdict: v, confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: false,
  reason: 'r', triggeredBy: ['heartbeat'], netPnl: 0, greenFloor: null, promptVersion: 'p1', ...over,
});

describe('brokerTradeRecord (Task 13b)', () => {
  it('maps a closed long option position: gross, the sentinel charge model, net, MFE/MAE, hold time', () => {
    const r = brokerTradeRecord(tracker(), []);
    if (!r.ok) throw new Error(r.skip);
    const fees = Math.round(estimateCharges({ segment: 'OPT', entryPrice: 100, exitPrice: 120, qty: 75, side: 'LONG' }) * 100) / 100;
    expect(r.record).toMatchObject({
      userId: 'user_A', source: BROKER_CORPUS_SOURCE, sourceId: 'trk_1', kind: BROKER_TRADE_KIND, decidedAt: ENTRY,
      instrumentType: 'OPT', direction: 'LONG', strategyKey: 'broker:manual', setupGroupKey: 'broker|NIFTY14OCT2525000CE|2026-10-13',
      featureSet: null, outcomeAt: EXIT,
    });
    expect(r.record.outcome).toEqual({
      entryPrice: 100, exitPrice: 120, qty: 75, grossPnl: 1500, fees, netPnl: Math.round((1500 - fees) * 100) / 100, win: true,
      mfe: 2250, mae: -750, mfePrice: 130, maePrice: 90, holdMins: 90, exitedAt: EXIT.toISOString(),
    });
  });

  it('a short future: the favourable extreme is the low', () => {
    const r = brokerTradeRecord(tracker({ symbol: 'NIFTY28OCT25FUT', qty: -75, entryPrice: 25000, exitPrice: 24900, holdingHigh: 25050, holdingLow: 24850 }), []);
    if (!r.ok) throw new Error(r.skip);
    expect(r.record).toMatchObject({ instrumentType: 'FUT', direction: 'SHORT' });
    expect(r.record.outcome).toMatchObject({ grossPnl: 7500, mfe: 11250, mae: -3750, mfePrice: 24850, maePrice: 25050 });
  });

  it('joins only the verdicts given while the position was open, oldest first, newest 50 kept, last verdict in the decision', () => {
    const inside = Array.from({ length: BROKER_VERDICTS_MAX + 5 }, (_, i) => verdict(new Date(ENTRY.getTime() + (i + 1) * 60_000)));
    const before = verdict(new Date(ENTRY.getTime() - 60_000), 'EXIT_NOW');
    const last = verdict(new Date(EXIT.getTime() - 1_000), 'EXIT_ARMED', { confidence: 'high', thesisStatus: 'WEAKENING' });
    const r = brokerTradeRecord(tracker(), [last, before, ...inside]);
    if (!r.ok) throw new Error(r.skip);
    const kept = r.record.evidence.verdicts as Array<{ at: string; verdict: string }>;
    expect(kept).toHaveLength(BROKER_VERDICTS_MAX);
    expect(kept[kept.length - 1]).toMatchObject({ verdict: 'EXIT_ARMED' });
    expect(kept.some((v) => v.verdict === 'EXIT_NOW')).toBe(false);
    expect(r.record.decision).toEqual({
      taken: true, by: 'human', reason: 'broker position (trade_trackers)', verdictCount: BROKER_VERDICTS_MAX + 6,
      lastVerdict: { at: last.createdAt.toISOString(), verdict: 'EXIT_ARMED', confidence: 'high', thesisStatus: 'WEAKENING' },
    });
  });

  it('no recorded extremes: MFE/MAE are null, never zero', () => {
    const r = brokerTradeRecord(tracker({ holdingHigh: null, holdingLow: null }), []);
    if (!r.ok) throw new Error(r.skip);
    expect(r.record.outcome).toMatchObject({ mfe: null, mae: null, mfePrice: null, maePrice: null });
  });

  it.each([
    ['NOT_CLOSED', { status: 'OPEN', exitPrice: null, exitTime: null }],
    ['NOT_POSITION', { kind: 'HOLDING' }],
    ['NOT_DERIVATIVE', { symbol: 'RELIANCE-EQ', exchange: 'NSE' }],
    ['BAD_SHAPE', { qty: 0 }],
    ['BAD_SHAPE', { exitTime: new Date(ENTRY.getTime() - 1) }],
  ] as const)('skips %s', (skip, over) => {
    expect(brokerTradeRecord(tracker(over as Partial<TrackerRow>), [])).toEqual({ ok: false, skip });
  });
});
