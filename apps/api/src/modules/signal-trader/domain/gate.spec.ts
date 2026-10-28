import { applyJudgeTightening, entryBand, evaluateGate, marketableLimit, planEntry, sizeEntry, type GateFacts } from './gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from './signal-trader.config';
import type { SignalView } from './signal.types';

const cfg = (over: Partial<SignalTraderConfig> = {}): SignalTraderConfig => ({ ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), ...over });

const signal = (over: Partial<SignalView> = {}): SignalView => ({
  id: 's1',
  channelId: 'c1',
  receivedAt: null,
  underlying: 'NIFTY',
  instrumentKind: 'CE',
  strike: 25000,
  expiry: null,
  side: 'BUY',
  entryLow: 100,
  entryHigh: 100,
  entryType: 'ABOVE',
  sl: 90,
  targets: [120, 140],
  qty: null,
  confidence: 0.9,
  rawText: 'BUY NIFTY 25000 CE ABOVE 100 SL 90 TGT 120 140',
  ...over,
});

const contract = { ok: true as const, contract: { exchange: 'NFO', token: '111', tradingsymbol: 'NIFTY28OCT2625000CE', lotSize: 75, tickSize: 0.05, expiry: '2026-10-28' } };

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    signal: signal(),
    ownerUserId: 'owner',
    marketOpen: true,
    minutesToClose: 200,
    contract,
    ltp: 101,
    engineSl: null,
    tradesToday: 0,
    signalLossToday: 0,
    clusterTaken: false,
    holding: false,
    coreKillSwitchOff: true,
    riskManager: { allowed: true },
    liveTradingEnabled: true,
    slEnforceable: { ok: true, detail: 'ok' },
    ...over,
  };
}

function run(f: GateFacts, c = cfg()) {
  const p = planEntry(f, c);
  return { ...evaluateGate(f, p.checks, c), plan: p.plan };
}

describe('signal gate', () => {
  it('passes a clean signal and records every check', () => {
    const r = run(facts());
    expect(r.pass).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      'mode', 'owner', 'side_allowed', 'market_hours', 'instrument_resolved', 'ltp_available', 'entry_tolerance',
      'sl_present', 'sl_side', 'risk_cap', 'targets', 'trades_today', 'daily_signal_loss', 'cluster_not_taken', 'not_holding',
      'kill_switch', 'risk_manager', 'live_trading_enabled', 'sl_enforceable',
    ]);
    expect(r.plan).toMatchObject({ lots: 1, qty: 75, sl: 90, targets: [120, 140], targetSource: 'signal' });
  });

  describe('engine targets (owner 2026-10-28: a call with no target gets ours)', () => {
    const engine = { targets: [115, 125], methods: ['level_delta', 'r_multiple'], detail: 'T1 115 = resistance 25060; T2 125 = 2.5 R' };

    it('the channel gave none: the plan trades the engine targets, and says so', () => {
      const r = run(facts({ signal: signal({ targets: [] }), engineTargets: engine }));
      expect(r.pass).toBe(true);
      expect(r.plan).toMatchObject({ targets: [115, 125], targetSource: 'engine', engineTargets: { methods: ['level_delta', 'r_multiple'] } });
      expect(r.checks.find((c) => c.name === 'targets')).toMatchObject({ ok: true, required: false, detail: expect.stringContaining('engine') });
    });

    it('the channel\'s own targets always win', () => {
      const r = run(facts({ engineTargets: engine }));
      expect(r.plan).toMatchObject({ targets: [120, 140], targetSource: 'signal' });
    });

    it('no target from either: still tradable, the check is a warning', () => {
      const r = run(facts({ signal: signal({ targets: [] }), engineTargets: { targets: [], methods: [], detail: 'no targets: no stop' } }));
      expect(r.pass).toBe(true);
      expect(r.plan).toMatchObject({ targets: [], targetSource: 'none' });
      expect(r.checks.find((c) => c.name === 'targets')).toMatchObject({ ok: false, required: false });
    });

    it('a late call that passed every channel target trades the engine targets ahead', () => {
      // ABOVE 100, LTP 145: past T1 120 and T2 140.
      const r = run(facts({ ltp: 145, engineTargets: { targets: [160, 170], methods: ['r_multiple', 'r_multiple'], detail: '1.5 R; 2.5 R' } }), cfg({ mode: 'paper', paperLearn: true }));
      expect(r.plan).toMatchObject({ targets: [160, 170], targetSource: 'engine' });
    });
  });

  it('resizes DOWN to fit the per-trade loss cap, never up', () => {
    // signal asks 4 lots → lot cap 2 → risk per lot (101.5-90)*75 = 862.5 → floor(2000/862.5)=2
    const r = run(facts({ signal: signal({ qty: 4 }) }));
    expect(r.plan?.lots).toBe(2);
    // wider stop: per lot (101.5-85)*75 = 1237.5 → only 1 lot fits
    const r2 = run(facts({ signal: signal({ qty: 2, sl: 85 }) }));
    expect(r2.plan?.lots).toBe(1);
    expect(r2.plan!.riskRupees).toBeLessThanOrEqual(2000);
  });

  it('SKIPs when ONE lot already exceeds the loss cap', () => {
    const r = run(facts({ signal: signal({ sl: 70 }) }));
    expect(r.pass).toBe(false);
    expect(r.skipReason).toBe('risk_cap');
    expect(r.checks.find((c) => c.name === 'risk_cap')?.detail).toMatch(/one_lot_exceeds_risk_cap/);
  });

  it('caps lots at SIGNAL_MAX_LOTS and reads a unit quantity as lots', () => {
    expect(sizeEntry({ kind: 'CE', qty: 750, lotSize: 75, limitPrice: 100, sl: 99 }, cfg())).toMatchObject({ ok: true, lots: 2, qty: 150 });
  });

  it('equity is capped by notional and risk', () => {
    const s = sizeEntry({ kind: 'EQ', qty: 1000, lotSize: 1, limitPrice: 500, sl: 490 }, cfg());
    expect(s).toMatchObject({ ok: true, qty: 100 }); // 50 000 / 500
  });

  it('no SL and no engine SL → SKIP sl_present', () => {
    const r = run(facts({ signal: signal({ sl: null }) }));
    expect(r.skipReason).toBe('sl_present');
  });

  it('uses an engine SL when the signal has none', () => {
    const r = run(facts({ signal: signal({ instrumentKind: 'EQ', sl: null, underlying: 'INFY', strike: null }), engineSl: 98, contract: { ok: true, contract: { ...contract.contract, lotSize: 1 } } }));
    expect(r.plan?.slSource).toBe('engine');
    expect(r.pass).toBe(true);
  });

  it('SL on the wrong side (already hit) → SKIP', () => {
    const r = run(facts({ signal: signal({ sl: 102 }) }));
    expect(r.skipReason).toBe('sl_side');
  });

  it('SIGNAL_LATE_ENTRY=off: LTP above the ABOVE band → SKIP; not yet reached → SKIP', () => {
    expect(run(facts({ ltp: 104 }), cfg({ lateEntry: false })).skipReason).toBe('entry_tolerance');
    const r = run(facts({ ltp: 99 }));
    expect(r.skipReason).toBe('entry_tolerance');
    expect(r.checks.find((c) => c.name === 'entry_tolerance')?.detail).toMatch(/not reached/);
    expect(entryBand({ entryType: 'RANGE', entryLow: 95, entryHigh: 100 }, 3)).toEqual({ low: 95, high: 100 });
  });

  describe('late entry (the price already ran past the channel\'s entry)', () => {
    it('plans at the current price, records the chase as a warning, keeps only the targets ahead', () => {
      // Paper: the wider stop from 125 (₹2.6k on one lot) is a risk_cap warning there; live would refuse it.
      const r = run(facts({ ltp: 125 }), cfg({ mode: 'paper' }));
      expect(r.checks.find((c) => c.name === 'risk_cap')).toMatchObject({ ok: false, required: false });
      expect(r.pass).toBe(true);
      const tol = r.checks.find((c) => c.name === 'entry_tolerance');
      expect(tol).toMatchObject({ ok: false, required: false });
      expect(tol?.detail).toMatch(/late: LTP 125 is 25% past the channel's 100/);
      expect(r.plan).toMatchObject({ ltp: 125, bandLow: 125, sl: 90, targets: [140], late: { channelEntry: 100, chasePct: 25, targetsPassed: [120] } });
      expect(r.plan!.limitPrice).toBeGreaterThanOrEqual(125);
      expect(r.plan!.limitPrice).toBeLessThanOrEqual(r.plan!.bandHigh);
    });

    it('more than SIGNAL_LATE_MAX_PCT past it is still a SKIP (the move is done, or the contract is wrong)', () => {
      const r = run(facts({ ltp: 150 }), cfg({ lateMaxPct: 40 }));
      expect(r.skipReason).toBe('entry_tolerance');
      expect(r.checks.find((c) => c.name === 'entry_tolerance')?.detail).toMatch(/> 40% — the move is done/);
      expect(r.plan).toBeNull();
    });

    it('a late BUY whose channel SL the price already fell through on the way is refused by sl_side', () => {
      // AT 100, SL 110 (nonsense for a buy) and the price ran to 120: the stop is above the price.
      const r = run(facts({ ltp: 120, signal: signal({ entryType: 'AT', sl: 125 }) }));
      expect(r.skipReason).toBe('sl_side');
      expect(r.plan).toBeNull();
    });

    it('a SELL is late when the price already fell past its entry', () => {
      const r = run(facts({ ltp: 90, signal: signal({ side: 'SELL', instrumentKind: 'FUT', entryType: 'AT', sl: 105, targets: [95, 80] }) }));
      expect(r.pass).toBe(true);
      expect(r.plan).toMatchObject({ bandHigh: 90, targets: [80], late: { channelEntry: 100, chasePct: 10, targetsPassed: [95] } });
    });

    it('a BUY whose price is already cheaper than the channel\'s is planned at the cheaper price', () => {
      // 2026-10-26 COPPER "BUY near 12", LTP 11.56: was a "chasing" SKIP.
      const r = run(facts({ ltp: 96, signal: signal({ entryType: 'AT' }) }));
      expect(r.pass).toBe(true);
      const tol = r.checks.find((c) => c.name === 'entry_tolerance');
      expect(tol).toMatchObject({ ok: false, required: false });
      expect(tol?.detail).toMatch(/better: LTP 96 is 4% below the channel's 100/);
      expect(r.plan).toMatchObject({ ltp: 96, bandLow: 96, better: { channelEntry: 100, betterPct: 4 } });
      expect(r.plan!.late).toBeUndefined();
    });

    it('a SELL above its entry is better too; far past SIGNAL_LATE_MAX_PCT it is refused', () => {
      const sell = signal({ side: 'SELL', instrumentKind: 'FUT', entryType: 'AT', sl: 110, targets: [95, 80] });
      expect(run(facts({ ltp: 104, signal: sell })).plan).toMatchObject({ bandHigh: 104, better: { channelEntry: 100, betterPct: 4 } });
      const far = run(facts({ ltp: 50, signal: signal({ entryType: 'AT', sl: 40 }) }), cfg({ lateMaxPct: 40 }));
      expect(far.skipReason).toBe('entry_tolerance');
      expect(far.checks.find((c) => c.name === 'entry_tolerance')?.detail).toMatch(/50% below the channel's 100 \(> 40%/);
    });

    it('a cheaper BUY whose price already fell through the SL is refused by sl_side', () => {
      const r = run(facts({ ltp: 88, signal: signal({ entryType: 'AT' }) }));
      expect(r.skipReason).toBe('sl_side');
    });

    it('a not-reached ABOVE entry is never late (it waits as a trigger)', () => {
      const r = run(facts({ ltp: 99 }));
      expect(r.plan).toBeNull();
      expect(r.checks.find((c) => c.name === 'entry_tolerance')?.detail).toMatch(/not reached/);
    });
  });

  it('the marketable LIMIT stays inside the band', () => {
    expect(marketableLimit('BUY', 102.9, { low: 100, high: 103 }, 0.5, 0.05)).toBe(103);
    expect(marketableLimit('BUY', 101, { low: 100, high: 103 }, 0.5, 0.05)).toBe(101.5);
    expect(marketableLimit('SELL', 100, { low: 97, high: 100 }, 0.5, 0.05)).toBe(99.5);
  });

  it.each([
    ['trades_today', { tradesToday: 3 }],
    ['daily_signal_loss', { signalLossToday: 10_000 }],
    ['cluster_not_taken', { clusterTaken: true }],
    ['not_holding', { holding: true }],
    ['kill_switch', { coreKillSwitchOff: false }],
    ['kill_switch', { coreKillSwitchOff: null }],
    ['risk_manager', { riskManager: { allowed: false, reason: 'Max daily loss limit reached' } }],
    ['market_hours', { marketOpen: false }],
    ['market_hours', { minutesToClose: 5 }],
    ['instrument_resolved', { contract: { ok: false as const, reason: 'no live contract' } }],
    ['owner', { ownerUserId: null }],
    ['trades_today', { tradesToday: null }],
  ])('%s blocks', (name, over) => {
    const r = run(facts(over as Partial<GateFacts>));
    expect(r.pass).toBe(false);
    expect(r.skipReason).toBe(name);
  });

  it('refuses option writing unless allowed', () => {
    const f = facts({ signal: signal({ side: 'SELL', entryType: 'BELOW', sl: 110 }), ltp: 99 });
    expect(run(f).skipReason).toBe('side_allowed');
  });

  it('live-only checks block in live, are recorded but not blocking in shadow', () => {
    const f = facts({ liveTradingEnabled: false, slEnforceable: { ok: false, detail: 'triggers off' } });
    const shadow = run(f, cfg({ mode: 'shadow' }));
    expect(shadow.pass).toBe(true);
    expect(shadow.checks.find((c) => c.name === 'sl_enforceable')).toMatchObject({ ok: false, required: false });
    const live = run(f, cfg({ mode: 'live' }));
    expect(live.pass).toBe(false);
    expect(live.skipReason).toBe('live_trading_enabled');
    expect(run(facts({ slEnforceable: { ok: false, detail: 'x' } }), cfg({ mode: 'live' })).skipReason).toBe('sl_enforceable');
  });

  it('mode off never passes', () => {
    expect(run(facts(), cfg({ mode: 'off' })).skipReason).toBe('mode');
  });

  describe('paper mode (owner 2026-10-26: test every call without touching the broker)', () => {
    // DRREDDY-like: lot 625, entry 50, engine SL 37.5 → 1 lot risks ≈ ₹7,969 > ₹2,000.
    const big = () =>
      facts({
        signal: signal({ underlying: 'DRREDDY', strike: 1240, entryLow: 50, entryHigh: 50, sl: null, targets: [] }),
        contract: { ok: true as const, contract: { ...contract.contract, tradingsymbol: 'DRREDDY27OCT261240CE', lotSize: 625 } },
        ltp: 50,
        engineSl: 37.5,
        engineSlInfo: { method: 'premium_pct', detail: '25%' },
      });

    it('one lot over the risk cap is a recorded warning with a 1-lot plan, not a block', () => {
      const r = run(big(), cfg({ mode: 'paper' }));
      expect(r.pass).toBe(true);
      expect(r.checks.find((c) => c.name === 'risk_cap')).toMatchObject({ ok: false, required: false });
      expect(r.plan).toMatchObject({ lots: 1, qty: 625 });
      expect(r.plan!.riskRupees).toBeGreaterThan(2000);
    });

    it('the same call still blocks on the risk cap in shadow and live', () => {
      expect(run(big(), cfg({ mode: 'shadow' })).skipReason).toBe('risk_cap');
      expect(run(big(), cfg({ mode: 'live' })).skipReason).toBe('risk_cap');
    });

    it('daily trade count / loss stop are warnings in paper (every call is tested)', () => {
      const r = run(facts({ tradesToday: 9, signalLossToday: 99_999 }), cfg({ mode: 'paper' }));
      expect(r.pass).toBe(true);
      expect(r.checks.find((c) => c.name === 'trades_today')).toMatchObject({ ok: false, required: false });
      expect(r.checks.find((c) => c.name === 'daily_signal_loss')).toMatchObject({ ok: false, required: false });
    });

    it('live-only switches never block paper', () => {
      const r = run(facts({ liveTradingEnabled: false, slEnforceable: { ok: false, detail: 'triggers off' } }), cfg({ mode: 'paper' }));
      expect(r.pass).toBe(true);
    });

    it('a chased entry past SIGNAL_LATE_MAX_PCT still fails in paper', () => {
      expect(run(facts({ ltp: 150 }), cfg({ mode: 'paper' })).skipReason).toBe('entry_tolerance');
    });
  });

  it('the judge may tighten SL / reduce lots but never loosen or enlarge', () => {
    const plan = run(facts({ signal: signal({ qty: 2 }) })).plan!;
    expect(plan.lots).toBe(2);
    const t = applyJudgeTightening(plan, { sl: 95, lots: 1 }, 'CE');
    expect(t.plan).toMatchObject({ sl: 95, lots: 1, qty: 75, slSource: 'judge' });
    const loose = applyJudgeTightening(plan, { sl: 80, lots: 5 }, 'CE');
    expect(loose.plan).toMatchObject({ sl: 90, lots: 2 });
    expect(loose.changed).toEqual([]);
    // an SL at/above LTP is not "tighter", it is already hit
    expect(applyJudgeTightening(plan, { sl: 101.5, lots: null }, 'CE').plan.sl).toBe(90);
  });
});
