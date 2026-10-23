import {
  latestPerWindowSymbol,
  newsConfirmed,
  openClose,
  pickNightVerdicts,
  readFactors,
  scoreLiveExit,
  scoreMbmPrediction,
  scoreMbmRelative,
  scoreNewsIdea,
  scoreOvernightVerdict,
  scoreScorecardFactors,
  scoreScorecardTotal,
  scoreStockMove,
  type ScorecardRow,
  type VerdictRow,
} from './scorers';

const S = '2026-10-21';
const sc = (o: Partial<ScorecardRow> = {}): ScorecardRow => ({
  id: 'sc1', symbol: 'NIFTY28OCT2625000CE', underlying: 'NIFTY', side: 'BULLISH', window: 'OVERNIGHT',
  computedAt: new Date('2026-10-20T10:10:00Z'), total: 2, band: 'SUPPORTS', moveBp: 40, sessionDate: S,
  factors: [
    { name: 'oi', points: 2, value: 'x', reason: 'r', available: true },
    { name: 'vix', points: -1, value: 'x', reason: 'r', available: true },
    { name: 'news', points: 1, value: 'x', reason: 'r', available: true },
    { name: 'mood', points: 0, value: 'x', reason: 'r', available: true },
    { name: 'expiry', points: 0, value: 'n/a', reason: 'unavailable', available: false },
  ],
  ...o,
});

describe('SCORECARD_TOTAL', () => {
  it('SUPPORTS + move in the side direction → right, score = signed bp', () => {
    expect(scoreScorecardTotal(sc())).toMatchObject({ kind: 'SCORECARD_TOTAL', refId: 'sc1', correct: true, score: 40 });
  });
  it('BEARISH side: an up move is against it', () => {
    expect(scoreScorecardTotal(sc({ side: 'BEARISH' }))).toMatchObject({ correct: false, score: -40 });
  });
  it('AGAINST band → right when the move went against the side', () => {
    expect(scoreScorecardTotal(sc({ band: 'STRONG_AGAINST', total: -5, moveBp: -30 }))).toMatchObject({ correct: true, score: 30 });
  });
  it('NEUTRAL → null, flat move → null', () => {
    expect(scoreScorecardTotal(sc({ band: 'NEUTRAL', total: 0 })).correct).toBeNull();
    expect(scoreScorecardTotal(sc({ moveBp: 0 })).correct).toBeNull();
  });
  it('latest per (window, symbol)', () => {
    const a = sc({ id: 'a', computedAt: new Date('2026-10-20T10:10:00Z') });
    const b = sc({ id: 'b', computedAt: new Date('2026-10-20T10:20:00Z') });
    const c = sc({ id: 'c', window: 'PRE_OPEN' });
    expect(latestPerWindowSymbol([a, b, c]).map((r) => r.id).sort()).toEqual(['b', 'c']);
  });
});

describe('SCORECARD_FACTOR', () => {
  it('one per factor, refId scorecardId:factor; + / − judged, 0 / unavailable null', () => {
    const out = scoreScorecardFactors(sc({ moveBp: -20 }));
    const by = Object.fromEntries(out.map((d) => [d.subject, d]));
    expect(by.oi).toMatchObject({ refId: 'sc1:oi', correct: false, score: -20 });
    expect(by.vix).toMatchObject({ correct: true, score: 20 });
    expect(by.mood.correct).toBeNull();
    expect(by.expiry.correct).toBeNull();
  });
  it('judges the RAW points when the factor was tuned', () => {
    const out = scoreScorecardFactors(sc({ factors: [{ name: 'oi', points: 0, rawPoints: 2, weight: 0, available: true }] }));
    expect(out[0]).toMatchObject({ correct: true, details: expect.objectContaining({ points: 2, appliedPoints: 0, weight: 0 }) });
  });
  it('records whether positive news was confirmed', () => {
    expect(newsConfirmed(readFactors(sc().factors))).toBe(true); // oi +2
    expect(newsConfirmed(readFactors([{ name: 'news', points: 2, available: true }, { name: 'oi', points: -1, available: true }]))).toBe(false);
    expect(newsConfirmed(readFactors([{ name: 'news', points: -1, available: true }]))).toBeNull();
  });
});

describe('OVERNIGHT_VERDICT', () => {
  const v = (id: string, at: string, verdict: string, tag = 'OVERNIGHT_REVIEW'): VerdictRow => ({
    id, trackerId: 't1', symbol: 'NIFTY28OCT2625000PE', verdict, confidence: 'high', createdAt: new Date(at), triggeredBy: [tag, `window:${tag}:EQUITY:x`],
  });
  it('latest per tracker, re-runs counted', () => {
    const picked = pickNightVerdicts([
      v('a', '2026-10-20T10:15:00Z', 'HOLD_OVERNIGHT'),
      v('b', '2026-10-21T03:00:00Z', 'EXIT_AT_OPEN', 'PRE_OPEN_REVIEW'),
      { ...v('c', '2026-10-20T10:20:00Z', 'HOLD'), triggeredBy: ['heartbeat'] },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ row: { id: 'b' }, reruns: 1, windows: ['OVERNIGHT_REVIEW', 'PRE_OPEN_REVIEW'] });
  });
  const base = { sessionDate: S, reruns: 0, windows: ['OVERNIGHT_REVIEW'], qty: 75, side: 'BEARISH' as const, proxyMoveBp: null };
  it('EXIT_AT_OPEN right when holding lost premium; score = ₹ saved', () => {
    const d = scoreOvernightVerdict({ ...base, verdict: v('x', '2026-10-20T10:15:00Z', 'EXIT_AT_OPEN'), prices: { open: 100, close: 80, source: 'candles_1m' } });
    expect(d).toMatchObject({ correct: true, score: 1500 });
  });
  it('HOLD_OVERNIGHT wrong when it lost; score = ₹ missed (negative)', () => {
    const d = scoreOvernightVerdict({ ...base, verdict: v('x', '2026-10-20T10:15:00Z', 'HOLD_OVERNIGHT'), prices: { open: 100, close: 80, source: 'candles_1m' } });
    expect(d).toMatchObject({ correct: false, score: -1500 });
  });
  it('short position: premium falling is a gain', () => {
    const d = scoreOvernightVerdict({ ...base, qty: -75, verdict: v('x', '2026-10-20T10:15:00Z', 'HOLD_OVERNIGHT'), prices: { open: 100, close: 80, source: 'candles_1m' } });
    expect(d.correct).toBe(true);
  });
  it('TIGHTEN_AT_OPEN null unless the move was large', () => {
    const small = scoreOvernightVerdict({ ...base, verdict: v('x', '2026-10-20T10:15:00Z', 'TIGHTEN_AT_OPEN'), prices: { open: 100, close: 95, source: 'c' } });
    expect(small.correct).toBeNull();
    const large = scoreOvernightVerdict({ ...base, verdict: v('x', '2026-10-20T10:15:00Z', 'TIGHTEN_AT_OPEN'), prices: { open: 100, close: 70, source: 'c' } });
    expect(large.correct).toBe(true);
  });
  it('no option prices → underlying proxy, flagged, no ₹ score', () => {
    const d = scoreOvernightVerdict({ ...base, proxyMoveBp: 50, verdict: v('x', '2026-10-20T10:15:00Z', 'EXIT_AT_OPEN'), prices: null });
    // a bearish position with the underlying up 50 bp lost → exit was right
    expect(d).toMatchObject({ correct: true, score: null, details: expect.objectContaining({ proxy: 'underlying-move' }) });
  });
  it('nothing at all → null', () => {
    expect(scoreOvernightVerdict({ ...base, verdict: v('x', '2026-10-20T10:15:00Z', 'EXIT_AT_OPEN'), prices: null }).correct).toBeNull();
  });
  it('openClose needs bars near the open and the close', () => {
    const open = Date.parse('2026-10-21T03:45:00Z');
    const close = Date.parse('2026-10-21T10:00:00Z');
    expect(openClose([{ ts: open, open: 100, close: 101 }, { ts: close - 60_000, open: 90, close: 88 }], open, close)).toEqual({ open: 100, close: 88 });
    expect(openClose([{ ts: open + 3 * 3_600_000, open: 100, close: 101 }], open, close)).toBeNull();
  });
});

describe('LIVE_EXIT', () => {
  const r = {
    executionId: 'e1', verdictId: 'v1', symbol: 'X', positionSide: 'LONG', qty: 50, decisionPrice: 100, decisionAt: new Date(),
    closeAt60: 90 as number | null, closeAtEnd: 95, sessionDate: S, minutesSinceOpen: 5,
  };
  it('long: lower 60 min later → right, score = ₹ saved', () => {
    expect(scoreLiveExit(r)).toMatchObject({ correct: true, score: 500 });
  });
  it('long: higher → wrong', () => {
    expect(scoreLiveExit({ ...r, closeAt60: 110 })).toMatchObject({ correct: false, score: -500 });
  });
  it('short: higher after → right', () => {
    expect(scoreLiveExit({ ...r, positionSide: 'SHORT', closeAt60: 110 }).correct).toBe(true);
  });
  it('falls back to the window end when the close came first', () => {
    expect(scoreLiveExit({ ...r, closeAt60: null })).toMatchObject({ correct: true, details: expect.objectContaining({ horizon: 'window-end' }) });
  });
});

describe('NEWS_IDEA', () => {
  const r = { id: 'i1', symbol: 'INFY', idea: 'CE_IDEA', headline: 'h', moveBp: 120, sessionDate: S, scorecardTotal: 2 as number | null, sentiment: 'bullish' as string | null, atrBp: 150 as number | null };
  it('CE right on an up move, PE wrong', () => {
    expect(scoreNewsIdea(r)).toMatchObject({ correct: true, score: 120 });
    expect(scoreNewsIdea({ ...r, idea: 'PE_IDEA' })).toMatchObject({ correct: false, score: -120 });
  });
  it('NO_TRADE right when |move| < 1×ATR', () => {
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE' }).correct).toBe(true);
  });
  it('NO_TRADE right when the scorecard was weak and the move faded the headline', () => {
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE', moveBp: -200, scorecardTotal: 0 }).correct).toBe(true);
  });
  it('NO_TRADE wrong on a ≥ ATR move with the headline', () => {
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE', moveBp: 200 }).correct).toBe(false);
  });
  it('NO_TRADE unsure → null', () => {
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE', atrBp: null }).correct).toBeNull();
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE', moveBp: 200, sentiment: 'neutral' }).correct).toBeNull();
    expect(scoreNewsIdea({ ...r, idea: 'NO_TRADE', moveBp: -200, scorecardTotal: 3 }).correct).toBeNull();
  });
});

describe('MBM_PREDICTION', () => {
  const r = {
    id: '7', instrument: 'NIFTY', horizon: '30m', asOf: new Date(), p: 0.7, regime: 'NORMAL', outcomeBig: true,
    outcomeQuality: 'ok' as string | null, outcomeRangeBp: 40, outcomeThresholdBp: 30, sessionDate: S,
  };
  it('(p ≥ 0.5) == outcome_big', () => {
    expect(scoreMbmPrediction(r).correct).toBe(true);
    expect(scoreMbmPrediction({ ...r, p: 0.3 }).correct).toBe(false);
    expect(scoreMbmPrediction({ ...r, p: 0.5, outcomeBig: false }).correct).toBe(false);
  });
  it('a gap outcome is not judged', () => {
    expect(scoreMbmPrediction({ ...r, outcomeQuality: 'gap' }).correct).toBeNull();
  });
});

describe('MBM_RELATIVE', () => {
  const r = {
    id: '7', instrument: 'NIFTY', horizon: '30m', asOf: new Date('2026-10-21T08:00:00Z'), p: 0.97, regime: 'ACTIVE', outcomeBig: true,
    outcomeQuality: 'ok' as string | null, outcomeRangeBp: 30, outcomeThresholdBp: 21, sessionDate: S,
    q50Bp: 32, relRatio: 1.52, relLabel: 'BUSIER' as string | null, refRangeBp: 21 as number | null,
  };
  it('BUSIER / MUCH_BUSIER: right when the realised range beat the reference', () => {
    expect(scoreMbmRelative(r)).toMatchObject({
      kind: 'MBM_RELATIVE', refId: '7', subject: '30m', symbol: 'NIFTY', correct: true,
      predicted: 'BUSIER (q50 32 bp = 1.52× ref 21 bp)', actual: 'range 30 bp = 1.43× ref',
      details: expect.objectContaining({ relLabel: 'BUSIER', realisedRatio: 1.43, refRangeBp: 21 }),
    });
    expect(scoreMbmRelative({ ...r, relLabel: 'MUCH_BUSIER', outcomeRangeBp: 18 })!.correct).toBe(false);
  });
  it('QUIETER: right below the reference; NORMAL: right within 0.8–1.25×', () => {
    expect(scoreMbmRelative({ ...r, relLabel: 'QUIETER', outcomeRangeBp: 15 })!.correct).toBe(true);
    expect(scoreMbmRelative({ ...r, relLabel: 'QUIETER', outcomeRangeBp: 25 })!.correct).toBe(false);
    expect(scoreMbmRelative({ ...r, relLabel: 'NORMAL', outcomeRangeBp: 17 })!.correct).toBe(true);
    expect(scoreMbmRelative({ ...r, relLabel: 'NORMAL', outcomeRangeBp: 21 * 1.25 })!.correct).toBe(true);
    expect(scoreMbmRelative({ ...r, relLabel: 'NORMAL', outcomeRangeBp: 30 })!.correct).toBe(false);
  });
  it('no draft without a relative reading; a gap outcome is not judged', () => {
    expect(scoreMbmRelative({ ...r, relLabel: null })).toBeNull();
    expect(scoreMbmRelative({ ...r, refRangeBp: null })).toBeNull();
    expect(scoreMbmRelative({ ...r, outcomeQuality: 'gap' })!.correct).toBeNull();
  });
});

describe('scoreStockMove', () => {
  const r = {
    id: '7', symbol: 'RELIANCE', asOf: new Date('2026-10-14T00:00:00Z'), horizonDays: 5, pBig: 0.71, rankPct: 0.97,
    bucket: 'TOP20', resultsInWindow: true, modelId: 'm1', outcomeBig: true, outcomeRetBp: 412.4, sessionDate: S,
  };
  it('(bucket = TOP20) == outcome_big for TOP20 / BOTTOM20; MID is not judged', () => {
    expect(scoreStockMove(r)).toMatchObject({
      kind: 'STOCK_MOVE', refId: '7', subject: 'TOP20', symbol: 'RELIANCE', correct: true, score: null,
      predicted: 'TOP20 p(big 5d)=0.71 (results in window)', actual: 'BIG move |ret| 412 bp over 5 sessions',
    });
    expect(scoreStockMove({ ...r, outcomeBig: false }).correct).toBe(false);
    expect(scoreStockMove({ ...r, bucket: 'BOTTOM20', outcomeBig: false }).correct).toBe(true);
    expect(scoreStockMove({ ...r, bucket: 'BOTTOM20', outcomeBig: true }).correct).toBe(false);
    expect(scoreStockMove({ ...r, bucket: 'MID' }).correct).toBeNull();
  });
  it('carries the bucket and outcome for the proposal rule', () => {
    expect(scoreStockMove(r).details).toMatchObject({ bucket: 'TOP20', outcomeBig: true, asOf: '2026-10-14', horizonDays: 5 });
  });
});
