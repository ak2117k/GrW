import { aiCheck, aiDecisionOf, aiScorecard } from './ai-check';
import { evaluateGate, planEntry, type GateFacts } from './gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from './signal-trader.config';
import type { SignalView } from './signal.types';

const at = new Date('2026-10-28T09:55:00Z');

describe('AI check: the judge held against the paper result', () => {
  it.each([
    ['TAKE and it made money → right', 'TAKE', 100, 112, true],
    ['TAKE and it lost → wrong', 'TAKE', 100, 95, false],
    ['SKIP and it lost → right', 'SKIP', 100, 95, true],
    ['SKIP and it made money → wrong', 'SKIP', 100, 112, false],
    ['SKIP and flat → right (no edge)', 'SKIP', 100, 100, true],
  ] as const)('%s', (_w, decision, entry, exit, correct) => {
    expect(aiCheck({ aiDecision: decision, side: 'BUY', entry, exit, qty: 75, exitTag: 'TIME_EXIT', at }).correct).toBe(correct);
  });

  it('a SELL is right when the price fell; no verdict or no prices is not scored', () => {
    expect(aiCheck({ aiDecision: 'TAKE', side: 'SELL', entry: 100, exit: 90, qty: 1, exitTag: 'HIT_TARGET', at })).toMatchObject({ correct: true, movePct: 10, pnl: 10 });
    expect(aiCheck({ aiDecision: 'NONE', side: 'BUY', entry: 100, exit: 120, qty: 1, exitTag: 'HIT_TARGET', at }).correct).toBeNull();
    expect(aiCheck({ aiDecision: 'TAKE', side: 'BUY', entry: null, exit: 120, qty: 1, exitTag: 'HIT_TARGET', at }).correct).toBeNull();
  });

  it('reads the AI call off the judge record; tallies the scorecard', () => {
    expect(aiDecisionOf({ aiDecision: 'SKIP', verdict: 'SKIP' })).toBe('SKIP');
    expect(aiDecisionOf(null)).toBe('NONE');
    expect(aiScorecard([{ aiDecision: 'TAKE', correct: true }, { aiDecision: 'SKIP', correct: false }, { aiDecision: 'SKIP', correct: true }, null, { aiDecision: 'NONE', correct: null }])).toEqual({
      scored: 3, right: 2, wrong: 1, accuracyPct: 67, takeRight: 1, takeWrong: 0, skipRight: 1, skipWrong: 1, unscored: 2,
    });
  });
});

describe('gate in PAPER learning mode', () => {
  const cfg = (over: Partial<SignalTraderConfig> = {}): SignalTraderConfig => ({ ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner', SIGNAL_TRADING: 'paper', SIGNAL_PAPER_LEARN: 'on' }), ...over });
  const signal = (over: Partial<SignalView> = {}): SignalView => ({
    id: 's1', channelId: 'c1', receivedAt: null, underlying: 'NIFTY', instrumentKind: 'CE', strike: 25000, expiry: null, side: 'BUY',
    entryLow: 100, entryHigh: 100, entryType: 'AT', sl: null, targets: [130], qty: null, confidence: 0.9, rawText: 'x', ...over,
  });
  const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
    signal: signal(), ownerUserId: 'owner', marketOpen: true, minutesToClose: 200,
    contract: { ok: true, contract: { exchange: 'NFO', token: '1', tradingsymbol: 'NIFTYCE', lotSize: 75, tickSize: 0.05, expiry: '2026-10-28' } },
    ltp: 101, engineSl: null, tradesToday: 9, signalLossToday: 50_000, clusterTaken: false, holding: false, coreKillSwitchOff: true,
    riskManager: { allowed: true }, liveTradingEnabled: false, slEnforceable: { ok: false, detail: 'paper' }, ...over,
  });
  const run = (f: GateFacts, c = cfg()) => {
    const p = planEntry(f, c);
    return { ...evaluateGate(f, p.checks, c), plan: p.plan };
  };

  it('no stop anywhere still trades: 1 lot, marked learn, the stop checks are warnings', () => {
    const r = run(facts());
    expect(r.pass).toBe(true);
    expect(r.plan).toMatchObject({ learn: true, lots: 1, qty: 75, sl: 0, slSource: 'none', targets: [130] });
    expect(r.checks.find((c) => c.name === 'sl_present')).toMatchObject({ ok: false, required: false });
  });

  it('a stop that breaks the risk cap is the judge\'s reference only; a 60%-late call is still tested', () => {
    const wide = run(facts({ signal: signal({ sl: 20 }) }));
    expect(wide.pass).toBe(true);
    expect(wide.plan).toMatchObject({ learn: true, sl: 20 });
    const late = run(facts({ ltp: 160 }));
    expect(late.pass).toBe(true);
    expect(late.plan?.late?.chasePct).toBe(60);
  });

  it('a doubled price (the contract is wrong) and a closed market are still refused; off = the old gate', () => {
    expect(run(facts({ ltp: 260 })).pass).toBe(false);
    expect(run(facts({ marketOpen: false })).skipReason).toBe('market_hours');
    expect(run(facts(), cfg({ paperLearn: false })).skipReason).toBe('sl_present');
  });
});
