import { fullLotMisfit, miniFallbackOn, miniMaxLots, miniNameFor, miniSymbolFor, planMini } from './mini-swap';
import type { ResolvedContract } from './contract-resolver';
import type { EntryPlan } from './gate';

const plan = (o: Partial<EntryPlan> = {}): EntryPlan => ({
  exchange: 'MCX', token: '1', tradingsymbol: 'GOLD27NOV26120000PE', lotSize: 1, tickSize: 0.5, side: 'BUY',
  ltp: 280, bandLow: 270, bandHigh: 290, limitPrice: 280, sl: 210, slSource: 'signal', targets: [350, 420],
  lots: 1, qty: 1, riskRupees: 7000, ...o,
});
const goldm: ResolvedContract = { exchange: 'MCX', token: '2', tradingsymbol: 'GOLDM27NOV26120000PE', lotSize: 100, tickSize: 0.5, expiry: '2026-11-27' };
const crudem: ResolvedContract = { exchange: 'MCX', token: '3', tradingsymbol: 'CRUDEOILM16DEC267450PE', lotSize: 10, tickSize: 0.1, expiry: '2026-12-16' };
const base = { fullLtp: 280, cap: 2000, available: 33_806, fundsBufferPct: 1, maxLots: 5 };

describe('mini names', () => {
  it('GOLD / CRUDEOIL / NATURALGAS have a same-expiry mini; SILVER and the minis themselves do not', () => {
    expect(miniNameFor('GOLD')).toBe('GOLDM');
    expect(miniNameFor('crudeoil')).toBe('CRUDEOILM');
    expect(miniNameFor('NATURALGAS')).toBe('NATGASMINI');
    expect(miniNameFor('SILVER')).toBeNull();
    expect(miniNameFor('GOLDM')).toBeNull();
    expect(miniSymbolFor('GOLD27NOV26120000PE', 'GOLD')).toBe('GOLDM27NOV26120000PE');
    expect(miniSymbolFor('NATURALGAS20NOV26290CE', 'NATURALGAS')).toBe('NATGASMINI20NOV26290CE');
    expect(miniSymbolFor('GOLDM27NOV26120000PE', 'GOLD')).toBeNull();
  });

  it('config: on by default with a cap of 5; off and bad caps fall back safely', () => {
    expect(miniFallbackOn({})).toBe(true);
    expect(miniFallbackOn({ SIGNAL_MINI_FALLBACK: 'off' })).toBe(false);
    expect(miniMaxLots({})).toBe(5);
    expect(miniMaxLots({ SIGNAL_MINI_MAX_LOTS: '2' })).toBe(2);
    expect(miniMaxLots({ SIGNAL_MINI_MAX_LOTS: '50' })).toBe(5);
  });

  it('swaps only when the full lot does not fit', () => {
    expect(fullLotMisfit({ fundsOk: false, riskRupees: 1000, cap: 2000 })).toBe('funds');
    expect(fullLotMisfit({ fundsOk: true, riskRupees: 7000, cap: 2000 })).toBe('risk');
    expect(fullLotMisfit({ fundsOk: null, riskRupees: 7000, cap: 7500 })).toBeNull();
  });
});

describe('planMini (2026-11-19 calls)', () => {
  it('GOLD 120000 PE @280 SL 210 → 2 GOLDM lots (₹1,400 risk, ₹5,600 premium)', () => {
    const r = planMini({ ...base, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ tradingsymbol: 'GOLDM27NOV26120000PE', token: '2', lotSize: 100, lots: 2, qty: 200, limitPrice: 280, sl: 210, riskRupees: 1400 });
    expect(r.byRisk).toBe(2);
  });

  it('CRUDEOIL 7450 PE @259.9 SL 194.9 → 3 CRUDEOILM lots (₹1,950)', () => {
    const p = plan({ tradingsymbol: 'CRUDEOIL16DEC267450PE', lotSize: 100, qty: 100, tickSize: 0.1, ltp: 259.9, bandLow: 255, bandHigh: 265, limitPrice: 259.9, sl: 194.9, targets: [300] });
    const r = planMini({ ...base, fullLtp: 259.9, plan: p, mini: crudem, miniLtp: 259.9 });
    expect(r.ok && r.plan.lots).toBe(3);
    expect(r.ok && r.plan.riskRupees).toBe(1950);
  });

  it('moves every level by the premium ratio (mini 2% dearer)', () => {
    const r = planMini({ ...base, plan: plan(), mini: goldm, miniLtp: 285.6 });
    expect(r.ok && r.plan.sl).toBe(214);
    expect(r.ok && r.plan.targets).toEqual([357, 428.5]);
  });

  it('funds can be the binding limit, and the cap of 5 is never exceeded', () => {
    expect(planMini({ ...base, available: 3_000, plan: plan(), mini: goldm, miniLtp: 280 }).ok && true).toBe(true);
    const one = planMini({ ...base, available: 3_000, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(one.ok && one.plan.lots).toBe(1);
    const wide = planMini({ ...base, cap: 50_000, available: 1e7, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(wide.ok && wide.plan.lots).toBe(5);
  });

  it('the judge may take fewer lots, never more', () => {
    const r = planMini({ ...base, judgeLots: 1, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(r.ok && r.plan.lots).toBe(1);
    const more = planMini({ ...base, judgeLots: 9, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(more.ok && more.plan.lots).toBe(2);
  });

  it('refuses: no mini price, a premium far off the full, a SELL, or not even 1 lot affordable', () => {
    expect(planMini({ ...base, plan: plan(), mini: goldm, miniLtp: null }).ok).toBe(false);
    expect(planMini({ ...base, plan: plan(), mini: goldm, miniLtp: 400 }).ok).toBe(false);
    expect(planMini({ ...base, plan: plan({ side: 'SELL' }), mini: goldm, miniLtp: 280 }).ok).toBe(false);
    const broke = planMini({ ...base, available: 475, plan: plan(), mini: goldm, miniLtp: 280 });
    expect(broke.ok).toBe(false);
    expect(!broke.ok && broke.reason).toMatch(/needs ₹2828 > available ₹475/);
  });
});
