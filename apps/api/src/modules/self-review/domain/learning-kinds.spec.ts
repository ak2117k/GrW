import { asFair, recoveryFromBars, scoreEngineEntry, scorePaperExit, scoreSignalJudge, wantOf, type PaperExitRow, type SignalJudgeRow } from './learning-kinds';
import { DIAGNOSED_KINDS } from '../services/self-review-run.service';
import { scopeForKind } from '../lessons/lessons.logic';
import { DIAGNOSIS_PROMPT_VERSION, DIAGNOSIS_SCHEMA, DIAGNOSIS_SYSTEM_PROMPT } from '../diagnose/diagnosis-prompt';
import { topMisses } from './summary';

const outcome = (result: string, price: number | null, pnl1Lot: number | null) => ({ stop: 272.25, result, price, pnl1Lot, reason: '' });
const judgeRow = (over: Partial<SignalJudgeRow> = {}): SignalJudgeRow => ({
  decisionId: 'cmvyv9u360749js01idwfzuut', sessionDate: '2026-11-02', symbol: 'NIFTY03NOV2623000CE', channelId: 'ch1',
  aiDecision: 'SKIP', confidence: 74, reasons: ['Risk busts the cap: SL 240 = ₹4,095 on 1 lot vs ₹2,000 max'],
  fair: { verdict: 'WRONG', skipKind: 'RISK_CAP', capStop: 272.25, capOutcome: outcome('TARGET', 340, 2403.49), signalStop: 240, signalStopOutcome: outcome('TARGET', 340, 2403.49), method: 'underlying-1m×delta', cap: 2000 },
  oldCorrect: false, exitTag: 'MOVED_STOP', paperPnl: 2939.74, promptVersion: 'signal-judge-v4', ...over,
});

describe('SIGNAL_JUDGE — the entry judge on the FAIR check', () => {
  it('NIFTY 23000 CE: a RISK_CAP SKIP whose cap-sized trade reached T1 is a miss, scored at the 1-lot ₹', () => {
    const d = scoreSignalJudge(judgeRow());
    expect(d).toMatchObject({ kind: 'SIGNAL_JUDGE', refId: 'cmvyv9u360749js01idwfzuut', subject: 'SKIP', correct: false, score: 2403.49 });
    expect(d.actual).toBe('cap-sized stop 272.25 → TARGET @ 340 +₹2403 (1 lot, underlying-1m×delta)');
    expect(d.details).toMatchObject({ skipKind: 'RISK_CAP', capStop: 272.25, oldNoStopCorrect: false, reasons: [expect.stringMatching(/busts the cap/)] });
  });
  it('a RISK_CAP SKIP that was right is not a miss; neither is a TAKE that paid', () => {
    expect(scoreSignalJudge(judgeRow({ fair: { ...judgeRow().fair!, verdict: 'RIGHT', capOutcome: outcome('STOPPED', 272.25, -2000) } })).correct).toBe(true);
    expect(scoreSignalJudge(judgeRow({ aiDecision: 'TAKE', fair: { ...judgeRow().fair!, verdict: 'RIGHT', skipKind: null } })).correct).toBe(true);
  });
  it('never falls back to the old no-stop rule: no fair block / UNSCORABLE / no verdict → not judged', () => {
    expect(scoreSignalJudge(judgeRow({ fair: null })).correct).toBeNull();
    expect(scoreSignalJudge(judgeRow({ fair: { ...judgeRow().fair!, verdict: 'UNSCORABLE', capOutcome: { ...outcome('UNSCORABLE', null, null), reason: 'path gap 20 min' } } })).actual).toMatch(/UNSCORABLE: path gap 20 min/);
    expect(scoreSignalJudge(judgeRow({ aiDecision: 'NONE' })).correct).toBeNull();
    expect(asFair({ verdict: 'MAYBE' })).toBeNull();
  });
});

const T = (hhmm: string) => Date.parse(`2026-10-30T${hhmm}:00.000Z`);
const flatThen = (exitClose: number, after: (k: number) => { high: number; low: number; close: number }) => [
  // 2 h before the exit: 1-min bars 10 points wide around 100 → N = 10
  ...Array.from({ length: 120 }, (_, k) => ({ ts: T('04:00') + k * 60_000, open: 100, high: 105, low: 95, close: k === 119 ? exitClose : 100 })),
  ...Array.from({ length: 30 }, (_, k) => ({ ts: T('06:00') + (k + 1) * 60_000, open: 100, ...after(k) })),
];
const exitRow = (over: Partial<PaperExitRow> = {}): PaperExitRow => ({
  tradeId: 't1', sessionDate: '2026-10-30', symbol: 'SENSEX30OCT2674500CE', underlying: 'SENSEX', exitRule: 'AI_EXIT', exitAt: new Date(T('06:00') + 20_000),
  want: 'BULLISH', entryPrice: 539.75, exitPrice: 520, qty: 20, reason: 'AI exit: dip below VWAP', n: 10, nSource: 'candles_1m', underlyingAtExit: 100,
  after15m: null, after30m: null, maxFavour30m: null, maxAgainst30m: null, noiseVerdict: null, noiseSummary: null, held: null, ...over,
});

describe('PAPER_EXIT — premature AI / trail exits of paper trades', () => {
  it('the underlying from candles_1m: N = 1-min ATR14 before the exit, excursions over the next 30 bars', () => {
    const p = recoveryFromBars(flatThen(100, (k) => ({ high: 100 + k, low: 99, close: 100 + k })), new Date(T('06:00') + 20_000), 'BULLISH');
    expect(p).toMatchObject({ n: 10, underlyingAtExit: 100, maxFavour30m: 29, maxAgainst30m: 1, after15m: 114, after30m: 129 });
    // a short (BEARISH) reads the same bars the other way round
    expect(recoveryFromBars(flatThen(100, (k) => ({ high: 100 + k, low: 99, close: 100 + k })), new Date(T('06:00') + 20_000), 'BEARISH')).toMatchObject({ maxFavour30m: 1, maxAgainst30m: 29 });
  });
  it('recovered ≥ 1 N in favour within 30 min → miss "premature exit"; scored in ₹ when the HELD follow knows', () => {
    const d = scorePaperExit(exitRow({ maxFavour30m: 17.6, maxAgainst30m: 2, noiseVerdict: 'NOISE', held: { rulePnl: 3520, heldPnl: -395, saved: 3915 } }));
    expect(d).toMatchObject({ kind: 'PAPER_EXIT', correct: false, score: 3915, details: { favourN: 1.76, noiseReadSaidNoise: true } });
    expect(d.actual).toMatch(/^premature exit: underlying 1.76 N in favour .* \(noise read said NOISE\); holding on its own rules \+₹3915 vs the exit/);
  });
  it('under 1 N of recovery → the exit held up (right); no path / no N → not judged', () => {
    expect(scorePaperExit(exitRow({ maxFavour30m: 6, maxAgainst30m: 25 }))).toMatchObject({ correct: true, score: 0.6 });
    expect(scorePaperExit(exitRow({ n: null })).correct).toBeNull();
    expect(scorePaperExit(exitRow({ underlyingAtExit: null })).correct).toBeNull();
  });
  it('without bar excursions the 15 / 30-min closes are used (noise-score rule)', () => {
    expect(scorePaperExit(exitRow({ after15m: 104, after30m: 112 })).correct).toBe(false);
  });
  it('a too-thin follow-up window (< 20 of 30 bars) gives no excursion', () => {
    const bars = flatThen(100, (k) => ({ high: 150, low: 99, close: 100 })).slice(0, 130);
    expect(recoveryFromBars(bars, new Date(T('06:00') + 20_000), 'BULLISH')).toMatchObject({ maxFavour30m: null, maxAgainst30m: null });
  });
  it('the want of a contract', () => {
    expect([wantOf('BUY', 'NIFTY03NOV2623000CE'), wantOf('BUY', 'X26OCT72800PE'), wantOf('SELL', 'CIPLA23NOV26FUT'), wantOf('BUY', 'SAKAR-EQ')]).toEqual(['BULLISH', 'BEARISH', 'BEARISH', 'BULLISH']);
  });
});

describe('ENGINE_ENTRY — closed engine paper trades', () => {
  const row = { id: 'e1', sessionDate: '2026-11-02', symbol: 'NIFTY03NOV2623300CE', underlying: 'NIFTY', side: 'BUY', quantity: 65, entryPrice: 100, exitPrice: 90, exitReasonTag: 'STOPPED_OUT', reasons: ['news + trend + OI agree'] };
  it('a gross loss is a miss, a gain is right, flat or unpriced is not judged', () => {
    expect(scoreEngineEntry(row)).toMatchObject({ kind: 'ENGINE_ENTRY', correct: false, score: -650, actual: 'STOPPED_OUT at 90 → gross −₹650' });
    expect(scoreEngineEntry({ ...row, exitPrice: 110 }).correct).toBe(true);
    expect(scoreEngineEntry({ ...row, exitPrice: 100 }).correct).toBeNull();
    expect(scoreEngineEntry({ ...row, exitPrice: null }).correct).toBeNull();
  });
});

describe('wiring: diagnosed kinds, scopes, prompt d6', () => {
  it('the new kinds reach the diagnosis; the existing ones are unchanged', () => {
    for (const k of ['SCORECARD_TOTAL', 'OVERNIGHT_VERDICT', 'LIVE_EXIT', 'NEWS_IDEA', 'TRADE_SETUP', 'SIGNAL_JUDGE', 'PAPER_EXIT', 'ENGINE_ENTRY'] as const) expect(DIAGNOSED_KINDS.has(k)).toBe(true);
    for (const k of ['SCORECARD_FACTOR', 'MBM_PREDICTION', 'MBM_RELATIVE', 'STOCK_MOVE', 'CHANNEL_SIGNAL', 'CHANNEL_INFO', 'NEWS_IMPACT'] as const) expect(DIAGNOSED_KINDS.has(k)).toBe(false);
    expect(DIAGNOSED_KINDS.size).toBe(8);
  });
  it('lesson scopes: SIGNAL_JUDGE → the entry judge, PAPER_EXIT → the sentinel exit, ENGINE_ENTRY → owner-only; old ones as before', () => {
    expect(['SIGNAL_JUDGE', 'PAPER_EXIT', 'ENGINE_ENTRY', 'OVERNIGHT_VERDICT', 'LIVE_EXIT', 'NEWS_IDEA', 'TRADE_SETUP'].map(scopeForKind)).toEqual(['SIGNAL_JUDGE', 'SENTINEL_LIVE', 'ENTRY_ENGINE', 'SENTINEL_OVERNIGHT', 'SENTINEL_LIVE', 'NEWS_IDEAS', 'ALL']);
    expect(DIAGNOSIS_SCHEMA.properties.misses.items.properties.scope.enum).toEqual(['SENTINEL_LIVE', 'SENTINEL_OVERNIGHT', 'NEWS_IDEAS', 'SIGNAL_JUDGE', 'ENTRY_ENGINE', 'ALL']);
  });
  it('the diagnosis prompt is d7 and describes each new kind', () => {
    expect(DIAGNOSIS_PROMPT_VERSION).toBe('d7');
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/A SIGNAL_JUDGE miss is .* FAIR check/);
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/Never propose raising the risk cap/);
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/A PAPER_EXIT miss is .* premature exit/);
    expect(DIAGNOSIS_SYSTEM_PROMPT).toMatch(/An ENGINE_ENTRY miss/);
  });
  it('the new misses rank with the old ones by |score| (₹)', () => {
    const misses = topMisses([scoreSignalJudge(judgeRow()), scorePaperExit(exitRow({ maxFavour30m: 17.6, maxAgainst30m: 2, held: { rulePnl: 0, heldPnl: 0, saved: 3915 } })), scoreEngineEntry({ id: 'e1', sessionDate: 's', symbol: null, underlying: null, side: 'BUY', quantity: 1, entryPrice: 10, exitPrice: 9, exitReasonTag: null, reasons: [] })], 15);
    expect(misses.map((m) => m.kind)).toEqual(['PAPER_EXIT', 'SIGNAL_JUDGE', 'ENGINE_ENTRY']);
  });
});
