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
      'sl_present', 'sl_side', 'risk_cap', 'trades_today', 'daily_signal_loss', 'cluster_not_taken', 'not_holding',
      'kill_switch', 'risk_manager', 'live_trading_enabled', 'sl_enforceable',
    ]);
    expect(r.plan).toMatchObject({ lots: 1, qty: 75, sl: 90 });
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

  it('no chasing: LTP above the ABOVE band → SKIP; not yet reached → SKIP', () => {
    expect(run(facts({ ltp: 104 })).skipReason).toBe('entry_tolerance');
    const r = run(facts({ ltp: 99 }));
    expect(r.skipReason).toBe('entry_tolerance');
    expect(r.checks.find((c) => c.name === 'entry_tolerance')?.detail).toMatch(/not reached/);
    expect(entryBand({ entryType: 'RANGE', entryLow: 95, entryHigh: 100 }, 3)).toEqual({ low: 95, high: 100 });
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

    it('a chased entry still fails in paper (no fill at the called price)', () => {
      expect(run(facts({ ltp: 130 }), cfg({ mode: 'paper' })).skipReason).toBe('entry_tolerance');
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
