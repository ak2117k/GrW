import { applyJudgeTightening, planEntry, riskCapFor, riskValueFactor, sizeEntry } from './gate';
import { parseSignalTraderConfig, type SignalTraderConfig } from './signal-trader.config';
import type { SignalView } from './signal.types';

/**
 * Prod 2026-11-04: GOLD27NOV26150000CE 566.5 with SL 424.5, lot 1 was gated as "risk ₹144.5 ≤ ₹2000".
 * GOLD is ₹100 per point per lot (master lotSize 1), so the real risk was ~₹14,200. Entry sizing now
 * multiplies by contractValueFactor and checks GOLD against its own cap (₹7,500, owner).
 */
const cfg = (over: Partial<SignalTraderConfig> = {}): SignalTraderConfig => ({ ...parseSignalTraderConfig({ HUB_OWNER_USER_ID: 'owner' }), ...over });
const CAPS = { maxLots: 1, maxLossPerTrade: 2000, maxNotional: 50_000, defaultLots: 1 };
const ENV = {}; // code defaults: HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING unset → GOLD:7500

const goldSignal: SignalView = {
  id: 's1', channelId: 'c1', receivedAt: null, underlying: 'GOLD', instrumentKind: 'CE', strike: 150000, expiry: '2026-11-27',
  side: 'BUY', entryLow: 560, entryHigh: 560, entryType: 'AT', sl: 424.5, targets: [600, 700, 1000], qty: null, confidence: null,
  rawText: 'BUY GOLD 150000 CE AT 560', horizon: 'INTRADAY',
};
const goldContract = { ok: true as const, contract: { exchange: 'MCX', token: '556656', tradingsymbol: 'GOLD27NOV26150000CE', lotSize: 1, tickSize: 0.5, expiry: '2026-11-27' } };

describe('entry sizing × contract value', () => {
  it('GOLD CE 566.5, SL 424.5, lot 1 → riskRupees 14200 (×100), refused against ₹7,500', () => {
    const vf = riskValueFactor('MCX', 'GOLD27NOV26150000CE', ENV);
    expect(vf).toBe(100);
    const at7500 = sizeEntry({ kind: 'CE', qty: null, lotSize: 1, limitPrice: 566.5, sl: 424.5, valueFactor: vf }, { ...CAPS, maxLossPerTrade: 7500 });
    expect(at7500).toMatchObject({ ok: false, reason: 'one_lot_exceeds_risk_cap' });
    expect(at7500.detail).toContain('risks ₹14200 > cap ₹7500');
    const wide = sizeEntry({ kind: 'CE', qty: null, lotSize: 1, limitPrice: 566.5, sl: 424.5, valueFactor: vf }, { ...CAPS, maxLossPerTrade: 20_000 });
    expect(wide).toMatchObject({ ok: true, lots: 1, qty: 1, riskRupees: 14200 });
  });

  it('NIFTY unchanged (factor 1, today’s cap)', () => {
    expect(riskValueFactor('NFO', 'NIFTY28OCT2625000CE', ENV)).toBe(1);
    expect(riskCapFor('NIFTY', 'NIFTY28OCT2625000CE', 2000, ENV)).toBe(2000);
    const r = sizeEntry({ kind: 'CE', qty: null, lotSize: 75, limitPrice: 101, sl: 90 }, CAPS);
    expect(r).toMatchObject({ ok: true, lots: 1, qty: 75, riskRupees: 825 });
    expect(sizeEntry({ kind: 'CE', qty: null, lotSize: 75, limitPrice: 101, sl: 90, valueFactor: 1 }, CAPS)).toEqual(r);
  });

  it('the cap: GOLD → ₹7,500 (lossLimitFor’s per-underlying figure); GOLDM, CRUDEOIL, NIFTY keep today’s cap; off = today’s cap', () => {
    expect(riskCapFor('GOLD', 'GOLD27NOV26150000CE', 2000, ENV)).toBe(7500);
    expect(riskCapFor('GOLDM', 'GOLDM05DEC26FUT', 2000, ENV)).toBe(2000);
    expect(riskCapFor('CRUDEOIL', 'CRUDEOIL17NOV269650PE', 2000, ENV)).toBe(2000);
    expect(riskCapFor('GOLD', 'GOLD27NOV26150000CE', 2000, { HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'off' })).toBe(2000);
    expect(riskCapFor('SILVER', 'SILVER27NOV26150000CE', 2000, { HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'GOLD:7500,SILVER:5000' })).toBe(5000);
  });

  it('SIGNAL_RISK_VALUE_FACTOR=off rolls back to the unscaled risk', () => {
    expect(riskValueFactor('MCX', 'GOLD27NOV26150000CE', { SIGNAL_RISK_VALUE_FACTOR: 'off' })).toBe(1);
  });

  it('planEntry: the live GOLD call of 4 Nov is now refused at the risk cap with the real figure', () => {
    const p = planEntry({ signal: goldSignal, contract: goldContract, ltp: 566.5, engineSl: null, engineSlInfo: null, engineTargets: null }, cfg({ mode: 'live', maxLossPerTrade: 2000 }), ENV);
    expect(p.plan).toBeNull();
    const rc = p.checks.find((x) => x.name === 'risk_cap');
    expect(rc).toMatchObject({ ok: false, required: true });
    expect(rc?.detail).toMatch(/1 lot \(1\) risks ₹1\d{4}(\.\d+)? > cap ₹7500/);
  });

  it('planEntry paper: 1 lot anyway, its risk recorded in real rupees', () => {
    const p = planEntry({ signal: goldSignal, contract: goldContract, ltp: 566.5, engineSl: null, engineSlInfo: null, engineTargets: null }, cfg({ mode: 'paper', paperLearn: false, maxLossPerTrade: 2000 }), ENV);
    expect(p.plan?.lots).toBe(1);
    expect(p.plan?.riskRupees).toBeGreaterThan(14_000);
    expect(p.checks.find((x) => x.name === 'risk_cap')?.detail).toMatch(/risks ₹14450 > cap ₹7500 — paper: 1 lot anyway/);
  });

  it('applyJudgeTightening recomputes riskRupees in real rupees too', () => {
    const plan = {
      exchange: 'MCX', token: '556656', tradingsymbol: 'GOLD27NOV26150000CE', lotSize: 1, tickSize: 0.5, side: 'BUY' as const, ltp: 566.5,
      bandLow: 543, bandHigh: 577, limitPrice: 566.5, sl: 424.5, slSource: 'engine' as const, targets: [600], lots: 1, qty: 1, riskRupees: 14200,
    };
    expect(applyJudgeTightening(plan, { sl: 500, lots: null }, 'CE').plan.riskRupees).toBe(6650);
  });
});
