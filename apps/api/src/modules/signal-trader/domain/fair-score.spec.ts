import { capSizedStop, contractPathFromUnderlying, fairCheck, replayStop, skipKindOf, type FairPath } from './fair-score';
import { buildFairPath, fairFromRecords, judgeFacts, pathDelta } from './fair-inputs';
import { aiScorecard, aiVerdictOf } from './ai-check';

/**
 * prod 2026-11-02, signal_decisions cmvyv9u360749js01idwfzuut — "Stock Gainers (SEBI Registered)":
 * BUY NIFTY 23000 CE AT 300 SL 240 T 340 → NIFTY03NOV2623000CE. Judge SKIP 74 (reason 1: SL 240 busts the
 * ₹2,000 cap). Learning paper trade cmvyvacya07bfjs011gok4033: entry 303.02323 at 06:17:42.915 UTC, exit
 * MOVED_STOP 348.25 at 06:51:33.818 UTC. No option 1-min bars are stored; the NIFTY index (NSE 99926000)
 * candles_1m below are prod's, read-only. Delta: the 03-NOV 23000 CE leg of mbm_chain_snapshots 06:15:42 is
 * null; the same strike's PE delta is −0.1299 ⇒ |Δce| = 0.8701 by put-call parity.
 */
const T = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00.000Z`);
// [UTC minute, open, high, low, close]
const NIFTY_1M: Array<[string, number, number, number, number]> = [
  ['06:15', 23311.05, 23311.95, 23302.3, 23303.15], ['06:16', 23305.4, 23309.95, 23301.45, 23303.75], ['06:17', 23305.4, 23305.4, 23297.45, 23301.4],
  ['06:18', 23302.85, 23304.35, 23294.2, 23297.45], ['06:19', 23299.55, 23300.6, 23293.25, 23295.35], ['06:20', 23297.55, 23297.55, 23289.8, 23295.1],
  ['06:21', 23294.95, 23294.95, 23282.1, 23286.7], ['06:22', 23286.7, 23294.25, 23286.5, 23291.6], ['06:23', 23294, 23302.05, 23292.55, 23299.7],
  ['06:24', 23301, 23306.75, 23297.9, 23305.35], ['06:25', 23307.15, 23308.95, 23296.45, 23308.35], ['06:26', 23310, 23310, 23303.45, 23304.1],
  ['06:27', 23305.45, 23308.2, 23301.1, 23305], ['06:28', 23307.25, 23309.6, 23302.5, 23304.15], ['06:29', 23305, 23311.75, 23301.4, 23310.05],
  ['06:30', 23312.35, 23316.95, 23309.35, 23314.5], ['06:31', 23314.35, 23318.85, 23314, 23317], ['06:33', 23312.3, 23313.2, 23303.8, 23305.05],
  ['06:34', 23305.85, 23314.25, 23303.25, 23312.5], ['06:35', 23314.75, 23314.75, 23301.85, 23305.05], ['06:36', 23306.8, 23313.55, 23301.75, 23313.1],
  ['06:37', 23314.85, 23318, 23307.65, 23308.45], ['06:38', 23310.1, 23318.4, 23309.35, 23315.3], ['06:39', 23317.05, 23325.45, 23314.15, 23322.55],
  ['06:40', 23322.55, 23324, 23318.75, 23322], ['06:41', 23323.9, 23337.85, 23322.7, 23337.3], ['06:42', 23336.7, 23341.7, 23334.4, 23335],
  ['06:43', 23337.35, 23337.35, 23327.55, 23330.7], ['06:44', 23330.9, 23336.9, 23328.45, 23335.55], ['06:45', 23336.95, 23343.9, 23334.65, 23341.2],
  ['06:46', 23343.35, 23352.55, 23341.75, 23351], ['06:47', 23352.3, 23352.3, 23340.6, 23344.05], ['06:48', 23345.4, 23349.15, 23342.6, 23345.3],
  ['06:49', 23345.65, 23349.15, 23343, 23343.15], ['06:50', 23344.95, 23345.05, 23334.25, 23335.4], ['06:51', 23337.35, 23337.45, 23329.3, 23331.45],
];
const bars = NIFTY_1M.map(([m, open, high, low, close]) => ({ ts: T(m), open, high, low, close }));
const ENTRY = 303.02323025844;
const ENTRY_TS = Date.parse('2026-11-02T06:17:42.915Z');
const EXIT = { ts: Date.parse('2026-11-02T06:51:33.818Z'), price: 348.25 };
const judge = {
  verdict: 'SKIP', aiDecision: 'SKIP', aiSkipReason: 'judge_skip', confidence: 74,
  reasons: [
    'Risk busts the cap: SL 240 is ₹63 away = ₹4,095 on 1 lot vs ₹2,000 max; forced tighten to ~272 (≈23271 spot) sits inside intraday noise, below ORH 23292 and the 23300 put wall',
    'Reward is thin for the risk: target 340 is only ~₹37 up',
    'Deep-ITM 23000 CE with expiry tomorrow quotes at/below intrinsic (302.95 vs ~305 spot intrinsic, fut 23365) — stale/illiquid quote',
    "Channel's direct-call record is poor (0 right / 1 wrong on 8 scored signals)",
  ],
  packet: {
    caps: { maxLots: 2, tradesToday: 0, maxLossPerTrade: 2000, maxTradesPerDay: 3 },
    market: { chain: { status: 'present', value: { spot: 23304.9, fut: 23365, expiry: '2026-11-03' } }, market: { status: 'present', value: { vix: 15.6525, spot: 23299.65 } } },
  },
};
const plan = { sl: 240, ltp: 302.95, qty: 65, lots: 1, side: 'BUY', lotSize: 65, targets: [340], tickSize: 0.05, riskRupees: 4189.25, tradingsymbol: 'NIFTY03NOV2623000CE' };

describe('fair score — the cap-sized stop', () => {
  it('NIFTY 23000 CE: entry 303.02 − ₹2,000 / 65 = 272.25', () => {
    expect(capSizedStop({ side: 'BUY', entry: ENTRY, cap: 2000, lotQty: 65, signalSl: 240 })).toBe(272.25);
  });
  it('never wider than the signal SL; a SELL sits above; no cap / a lot that cannot lose the cap → the signal SL', () => {
    expect(capSizedStop({ side: 'BUY', entry: 100, cap: 2000, lotQty: 50, signalSl: 90 })).toBe(90); // 1 lot risks 500 at SL 90 < cap
    expect(capSizedStop({ side: 'SELL', entry: 100, cap: 500, lotQty: 50, signalSl: 120 })).toBe(110);
    expect(capSizedStop({ side: 'BUY', entry: 10, cap: 2000, lotQty: 50, signalSl: null })).toBeNull(); // 10 − 40 < 0
    expect(capSizedStop({ side: 'BUY', entry: 100, cap: null, lotQty: 50, signalSl: 90 })).toBeNull();
  });
});

describe('fair score — NIFTY 23000 CE replay (underlying 1-min × parity delta 0.8701)', () => {
  const facts = judgeFacts(judge, plan, 65);
  const delta = pathDelta({ kind: 'CE', facts, chainOtherLeg: -0.1299, strike: 23000, expiry: '2026-11-03', at: new Date(ENTRY_TS), index: true });
  const path = buildFairPath({ kind: 'CE', entry: ENTRY, entryTs: ENTRY_TS, underlyingBars: bars, underlyingLabel: 'NIFTY', delta });

  it('the path: u0 = the 06:17 close, the 06:21 low 23282.1 maps to ≈ 286.2 — 14 premium points above the cap stop', () => {
    expect(delta).toEqual({ abs: 0.8701, source: expect.stringMatching(/^chain-parity/) });
    expect(path?.method).toBe('underlying-1m×delta');
    const low = Math.min(...(path as FairPath).points.map((p) => p.low));
    expect(low).toBeCloseTo(ENTRY + 0.8701 * (23282.1 - 23301.4), 1);
    expect(low).toBeGreaterThan(272.25);
  });

  it('the cap-sized version survives and reaches T1 340 at 06:45 → the SKIP was WRONG; the decisive reason was the cap', () => {
    const c = fairFromRecords({ judge, plan, side: 'BUY', entry: ENTRY, entryTs: ENTRY_TS, exit: EXIT, fallbackLotQty: 65, path });
    expect(c).toMatchObject({
      verdict: 'WRONG',
      skipKind: 'RISK_CAP',
      capStop: 272.25,
      signalStop: 240,
      target: 340,
      capSource: 'packet',
      capOutcome: { result: 'TARGET', price: 340, at: '2026-11-02T06:45:00.000Z' },
      signalStopOutcome: { result: 'TARGET', price: 340 },
    });
    expect(c.capOutcome.pnl1Lot).toBeCloseTo((340 - ENTRY) * 65, 0);
  });

  it('with a delta of 1.0 the cap stop is still 15.8 index points clear; it is hit only when the low reaches 23270.6', () => {
    const d1 = buildFairPath({ kind: 'CE', entry: ENTRY, entryTs: ENTRY_TS, underlyingBars: bars, delta: { abs: 1, source: 'test' } });
    const ok = fairFromRecords({ judge, plan, side: 'BUY', entry: ENTRY, entryTs: ENTRY_TS, exit: EXIT, fallbackLotQty: 65, path: d1 });
    expect(ok.capOutcome.result).toBe('TARGET');
    const deeper = bars.map((b) => (b.ts === T('06:21') ? { ...b, low: 23270 } : b));
    const hit = fairFromRecords({ judge, plan, side: 'BUY', entry: ENTRY, entryTs: ENTRY_TS, exit: EXIT, fallbackLotQty: 65, path: buildFairPath({ kind: 'CE', entry: ENTRY, entryTs: ENTRY_TS, underlyingBars: deeper, delta: { abs: 1, source: 'test' } }) });
    expect(hit).toMatchObject({ verdict: 'RIGHT', capOutcome: { result: 'STOPPED', price: 272.25 }, signalStopOutcome: { result: 'TARGET' } });
  });
});

describe('fair score — replay rules', () => {
  const pt = (m: string, high: number, low: number) => ({ ts: T(m), high, low, span: 60_000 });
  const path = (points: ReturnType<typeof pt>[], extra: Partial<FairPath> = {}): FairPath => ({ method: 'contract-1m (test)', points, ...extra });
  const base = { side: 'BUY', entry: 100, entryTs: T('10:00') + 5_000, target: 120, lotQty: 10 };

  it('stop and target in one bar: stop first, ambiguous', () => {
    const r = replayStop({ ...base, stop: 90, exit: { ts: T('10:10'), price: 105 }, path: path([pt('10:01', 121, 89)]) });
    expect(r).toMatchObject({ result: 'STOPPED', price: 90, pnl1Lot: -100, ambiguous: true });
  });
  it('neither reached → the paper exit; a gap before any event → UNSCORABLE (never guessed)', () => {
    const pts = ['10:01', '10:02', '10:03'].map((m) => pt(m, 105, 98));
    expect(replayStop({ ...base, stop: 90, exit: { ts: T('10:04'), price: 103 }, path: path(pts) })).toMatchObject({ result: 'EXIT', price: 103, pnl1Lot: 30 });
    expect(replayStop({ ...base, stop: 90, exit: { ts: T('10:30'), price: 103 }, path: path(pts) }).result).toBe('UNSCORABLE');
    expect(replayStop({ ...base, stop: 90, exit: { ts: T('10:30'), price: 103 }, path: path([pt('10:20', 105, 98)]) }).reason).toMatch(/path gap 20 min/);
  });
  it('a bar that ends after the exit is not replayed (nothing left inside the trade → UNSCORABLE); a SELL stops on the high', () => {
    expect(replayStop({ ...base, stop: 90, exit: { ts: T('10:01') + 30_000, price: 101 }, path: path([pt('10:01', 130, 80)]) })).toMatchObject({ result: 'UNSCORABLE', reason: expect.stringMatching(/no path point inside the trade/) });
    expect(replayStop({ side: 'SELL', entry: 100, entryTs: T('10:00'), target: 80, lotQty: 1, stop: 110, exit: { ts: T('10:05'), price: 95 }, path: path([pt('10:01', 111, 99)]) })).toMatchObject({ result: 'STOPPED', pnlPerUnit: -10 });
  });
  it('the shadow\'s seen signal-stop breach stops a cap stop that is no wider, even with no bars', () => {
    const seen = path([], { method: 'paper-watch shadow only', signalStopSeen: { ts: T('10:20'), price: 89 } });
    expect(replayStop({ ...base, stop: 95, stopWithinSignal: true, exit: { ts: T('10:40'), price: 130 }, path: seen })).toMatchObject({ result: 'STOPPED', price: 95 });
    expect(replayStop({ ...base, stop: 95, stopWithinSignal: false, exit: { ts: T('10:40'), price: 130 }, path: seen }).result).toBe('UNSCORABLE');
  });
  it('TAKE is symmetric; NONE and no path are UNSCORABLE', () => {
    const p = path([pt('10:01', 121, 99)]);
    const take = fairCheck({ aiDecision: 'TAKE', side: 'BUY', entry: 100, entryTs: base.entryTs, exit: { ts: T('10:05'), price: 101 }, signalSl: 90, targets: [120], lotQty: 10, cap: 200, path: p, judge: { reasons: ['OI supports'], riskRupees: 100 } });
    expect(take).toMatchObject({ verdict: 'RIGHT', skipKind: null, capStop: 90, capOutcome: { result: 'TARGET' } });
    expect(fairCheck({ aiDecision: 'NONE', side: 'BUY', entry: 100, entryTs: base.entryTs, exit: { ts: T('10:05'), price: 101 }, signalSl: 90, targets: [120], lotQty: 10, cap: 200, path: p, judge: { reasons: [], riskRupees: 100 } }).verdict).toBe('UNSCORABLE');
    expect(fairCheck({ aiDecision: 'SKIP', side: 'BUY', entry: 100, entryTs: base.entryTs, exit: { ts: T('10:05'), price: 101 }, signalSl: 90, targets: [120], lotQty: 10, cap: 200, path: null, judge: { reasons: [], riskRupees: 100 } }).verdict).toBe('UNSCORABLE');
  });
  it('a PE maps from the underlying\'s high', () => {
    const { points } = contractPathFromUnderlying({ bars: [{ ts: T('10:00'), high: 101, low: 99, close: 100 }, { ts: T('10:01'), high: 104, low: 99, close: 103 }], entry: 50, entryTs: T('10:00') + 10_000, kind: 'PE', absDelta: 0.5 });
    expect(points).toEqual([{ ts: T('10:01'), high: 50.5, low: 48, span: 60_000 }]);
  });
});

describe('skipKind — risk cap vs judgement', () => {
  const k = (reasons: string[], riskRupees: number | null, aiSkipReason: string | null = 'judge_skip') => skipKindOf({ aiDecision: 'SKIP', reasons, aiSkipReason, riskRupees, cap: 2000 });
  it('RISK_CAP only when the 1-lot risk broke the cap AND the decisive (first) reason is about it', () => {
    expect(k(judge.reasons, 4189.25)).toBe('RISK_CAP');
    expect(k(['Max loss per trade exceeded on 1 lot'], 2500)).toBe('RISK_CAP');
    expect(k(['Trend is against the call', 'SL busts the cap'], 4189.25)).toBe('JUDGEMENT');
    expect(k(['Risk busts the cap'], 1500)).toBe('JUDGEMENT');
  });
  it('not a SKIP, or the judge never answered → no kind', () => {
    expect(skipKindOf({ aiDecision: 'TAKE', reasons: ['cap'], riskRupees: 5000, cap: 2000 })).toBeNull();
    expect(k(['x'], 5000, 'judge_unavailable')).toBeNull();
  });
});

describe('the scorecard reads the fair verdict', () => {
  it('fair first (UNSCORABLE = unscored, never the old rule), old rule only without a fair block; old totals kept beside', () => {
    const fair = (verdict: 'RIGHT' | 'WRONG' | 'UNSCORABLE', skipKind: 'RISK_CAP' | 'JUDGEMENT' | null) => ({ verdict, skipKind }) as never;
    const checks = [
      { aiDecision: 'SKIP' as const, correct: false, fair: fair('RIGHT', 'RISK_CAP') },
      { aiDecision: 'SKIP' as const, correct: false, fair: fair('WRONG', 'JUDGEMENT') },
      { aiDecision: 'SKIP' as const, correct: true, fair: fair('UNSCORABLE', 'JUDGEMENT') },
      { aiDecision: 'TAKE' as const, correct: true },
    ];
    expect(aiVerdictOf(checks[0])).toEqual({ right: true, basis: 'fair', skipKind: 'RISK_CAP' });
    expect(aiScorecard(checks)).toMatchObject({
      scored: 3, right: 2, wrong: 1, accuracyPct: 67, unscored: 1, oldBasis: 1, takeRight: 1, skipRight: 1, skipWrong: 1,
      skipRightRiskCap: 1, skipWrongRiskCap: 0, skipRightJudgement: 0, skipWrongJudgement: 1,
      old: { scored: 4, right: 2, wrong: 2, accuracyPct: 50 },
    });
  });
});
