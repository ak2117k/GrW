import { detectEventNoAction, detectInputMissing, detectLiveNotPlaced, detectThesisContradictions, missingBlocks, type LiveCallSrc, type ThesisSrc } from './detectors';

const S = '2026-11-04';
const at = (hhmmIst: string) => new Date(`${S}T${hhmmIst}:00+05:30`);

describe('LIVE_NOT_PLACED', () => {
  it('11-04 shape: 12 risk_manager blocks ⇒ one LIVE_NOT_PLACED row with count 12', () => {
    const calls: LiveCallSrc[] = Array.from({ length: 12 }, (_, k) => ({
      id: `sd${k}`, userId: 'owner', underlying: k % 2 ? 'NIFTY' : 'GOLD', decidedAt: at(`1${k % 5}:0${k % 10}`), mode: 'live', decision: 'PAPER',
      judge: { aiDecision: k < 5 ? 'TAKE' : 'SKIP', liveGateBlocked: 'risk_manager' }, orderStatus: null, takePnl: k < 3 ? 1000 : null,
    }));
    // A placed live order and a shadow-mode call are not hits.
    calls.push({ id: 'ok', userId: 'owner', underlying: 'NIFTY', decidedAt: at('10:00'), mode: 'live', decision: 'TAKE', judge: { aiDecision: 'TAKE' }, orderStatus: 'FILLED', takePnl: 500 });
    calls.push({ id: 'shadow', userId: 'owner', underlying: 'NIFTY', decidedAt: at('10:00'), mode: 'shadow', decision: 'TAKE', judge: { liveGateBlocked: 'risk_manager' }, orderStatus: null, takePnl: null });
    const rows = detectLiveNotPlaced(S, calls);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r).toMatchObject({ decisionType: 'DETECTOR', detector: 'LIVE_NOT_PLACED', verdict: 'WRONG', refId: `LIVE_NOT_PLACED:${S}:risk_manager`, deltaRupees: 3000 });
    expect(r.facts).toMatchObject({ blocker: 'risk_manager', count: 12, judgeTakes: 5, graded: 3, byUnderlying: { GOLD: 6, NIFTY: 6 } });
  });

  it('a live TAKE with no order row, or a rejected one, is grouped by that', () => {
    const base = { userId: 'owner', underlying: 'NIFTY', decidedAt: at('10:00'), mode: 'live', decision: 'TAKE', judge: { aiDecision: 'TAKE' }, takePnl: null };
    const rows = detectLiveNotPlaced(S, [{ ...base, id: 'a', orderStatus: null }, { ...base, id: 'b', orderStatus: 'REJECTED' }]);
    expect(rows.map((r) => r.facts.blocker).sort()).toEqual(['no_order', 'order_rejected']);
  });
});

describe('THESIS_CONTRADICTS_DATA', () => {
  const laurus: ThesisSrc = {
    id: 'th1', userId: 'owner', trackerId: 'trk-laurus', symbol: 'LAURUSLABS23NOV262600CE', direction: 'LONG', source: 'INFERRED',
    reason: 'breakout above PDH 2343.9, cleared and held', levelPrice: 2343.9, invalidation: 2343.9, createdAt: at('10:05'), underlying: 'LAURUSLABS', underlyingAtEntry: 2310,
  };

  it('LAURUSLABS 2600CE thesis 2343.9 vs 2310 ⇒ THESIS_CONTRADICTS_DATA', () => {
    const [r] = detectThesisContradictions([laurus]);
    expect(r).toMatchObject({ decisionType: 'DETECTOR', detector: 'THESIS_CONTRADICTS_DATA', refTable: 'sentinel_theses', refId: 'th1', verdict: 'WRONG', sessionDate: S });
    expect(r.facts).toMatchObject({ what: 'INVALIDATION_BREACHED', underlyingAtEntry: 2310 });
  });

  it('a claimed break the price had not made, a long PE mirrored, and the clean / unknown cases', () => {
    expect(detectThesisContradictions([{ ...laurus, invalidation: 2280 }])[0].facts.what).toBe('LEVEL_NOT_BROKEN');
    // A bought PE is BEARISH the underlying: its invalidation sits ABOVE the price — 2343.9 vs 2310 is fine.
    expect(detectThesisContradictions([{ ...laurus, symbol: 'LAURUSLABS23NOV262300PE', reason: 'rejection at PDH', levelPrice: null }])).toHaveLength(0);
    expect(detectThesisContradictions([{ ...laurus, invalidation: 2280, levelPrice: 2300 }])).toHaveLength(0);
    expect(detectThesisContradictions([{ ...laurus, underlyingAtEntry: null }])).toHaveLength(0);
    expect(detectThesisContradictions([{ ...laurus, source: 'USER' }])).toHaveLength(0);
  });
});

describe('EVENT_NO_ACTION', () => {
  const midterms = { status: 'present' as const, events: [{ name: 'US_MIDTERM_RESULTS', at: `${S} IST session`, impact: 'high' as const, affects: ['GOLD', 'SILVER', 'NIFTY'], expectMove: true }] };

  it('GOLD on US_MIDTERM_RESULTS with 0 takes and a channel call ⇒ EVENT_NO_ACTION', () => {
    const [r] = detectEventNoAction(S, [{ underlying: 'GOLD', context: midterms, takes: 0, channelCalls: 1, moveAtr: null, at: at('11:01') }]);
    expect(r).toMatchObject({ detector: 'EVENT_NO_ACTION', underlying: 'GOLD', refId: `EVENT_NO_ACTION:${S}:GOLD`, verdict: 'WRONG' });
    expect(r.reason).toMatch(/US_MIDTERM_RESULTS/);
  });

  it('a take, no call and a small move, or an unreadable calendar ⇒ no hit; a 2× ATR move alone ⇒ hit', () => {
    const day = { underlying: 'NIFTY', context: midterms, takes: 0, channelCalls: 0, moveAtr: 1.2, at: at('09:15') };
    expect(detectEventNoAction(S, [{ ...day, underlying: 'GOLD', takes: 1, channelCalls: 1 }])).toHaveLength(0);
    expect(detectEventNoAction(S, [day])).toHaveLength(0);
    expect(detectEventNoAction(S, [{ ...day, context: { status: 'absent', reason: 'calendar empty' }, channelCalls: 3 }])).toHaveLength(0);
    expect(detectEventNoAction(S, [{ ...day, moveAtr: 2.4 }])).toHaveLength(1);
  });
});

describe('INPUT_MISSING', () => {
  it('one row per source × underlying with the missing blocks counted', () => {
    const rows = detectInputMissing(S, [
      { source: 'judge', underlying: 'GOLD', at: at('11:01'), userId: 'owner', blocks: { chain: { status: 'unavailable', reason: 'no chain' }, vix: { status: 'unavailable' }, structure: { status: 'present', value: {} } } },
      { source: 'judge', underlying: 'GOLD', at: at('12:00'), userId: 'owner', blocks: { chain: { status: 'unavailable' }, vix: { status: 'present', value: {} } } },
      { source: 'judge', underlying: 'NIFTY', at: at('12:00'), userId: 'owner', blocks: { chain: { status: 'present', value: {} } } },
      { source: 'engine', underlying: 'GOLD', at: at('12:00'), userId: null, blocks: { news: { lean: 'NO_DATA' }, trend: { lean: 'BULL' }, oi: { lean: 'NO_DATA' } } },
    ]);
    expect(rows.map((r) => r.refId).sort()).toEqual([`INPUT_MISSING:${S}:engine:GOLD`, `INPUT_MISSING:${S}:judge:GOLD`]);
    const judge = rows.find((r) => r.refId.includes('judge'))!;
    expect(judge.facts).toMatchObject({ count: 2, decisions: 2, blocks: { chain: 2, vix: 1 } });
  });

  it("the engine's news NO_DATA is a reading (no news), not a missing input", () => {
    expect(missingBlocks('engine', { news: { lean: 'NO_DATA' } })).toEqual([]);
    expect(missingBlocks('judge', { news: { status: 'unavailable' } })).toEqual(['news']);
  });
});
