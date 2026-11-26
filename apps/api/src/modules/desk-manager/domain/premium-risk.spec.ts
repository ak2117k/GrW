import { DEFAULT_CEILINGS } from '../desk-manager.config';
import { ceilingFor, estimatePremiumLoss, estimateSpread, pickContractSpec, premiumStop } from './premium-risk';

const cfg = { ceilings: { ...DEFAULT_CEILINGS } };

describe('estimatePremiumLoss', () => {
  it('BSE fixture: 130 × 0.5 × 375 + 1 × 375 = 24 750', () => {
    expect(
      estimatePremiumLoss({ side: 'BUY_CE', strikePolicy: 'ATM', underlyingEntry: 3890, underlyingStop: 3760, lotQty: 375, valueFactor: 1, delta: null, spread: 1 }),
    ).toBe(24750);
  });

  it('refuses when above the STOCK_OPT ceiling 3000', () => {
    const loss = estimatePremiumLoss({ side: 'BUY_CE', strikePolicy: 'ATM', underlyingEntry: 3890, underlyingStop: 3760, lotQty: 375, valueFactor: 1, delta: null, spread: 1 });
    const ceiling = ceilingFor('BSE', 'NFO', 'BSE30DEC263900CE', cfg);
    expect(ceiling).toBe(3000);
    expect(loss > ceiling).toBe(true);
  });

  it('uses the given delta, policy deltas and the MCX rupee factor', () => {
    const base = { side: 'BUY_PE' as const, underlyingEntry: 100, underlyingStop: 110, lotQty: 10, valueFactor: 1, spread: 0 };
    expect(estimatePremiumLoss({ ...base, strikePolicy: 'ATM', delta: 0.3 })).toBe(30);
    expect(estimatePremiumLoss({ ...base, strikePolicy: 'ITM1', delta: null })).toBe(60);
    expect(estimatePremiumLoss({ ...base, strikePolicy: 'OTM1', delta: null })).toBe(40);
    expect(estimatePremiumLoss({ ...base, side: 'BUY_FUT', strikePolicy: 'ATM', delta: null })).toBe(100);
    expect(estimatePremiumLoss({ ...base, strikePolicy: 'ATM', delta: null, valueFactor: 100, spread: 1 })).toBe(50 * 100 + 1000);
  });
});

describe('estimateSpread / premiumStop', () => {
  it('spread is max(tick, 1% of premium)', () => {
    expect(estimateSpread(3, 0.05)).toBe(0.05);
    expect(estimateSpread(250, 0.05)).toBe(2.5);
  });

  it('premium SL = entry − loss / (lotQty × valueFactor), floored at a tick', () => {
    expect(premiumStop({ entryPremium: 100, loss: 2000, lotQty: 75, valueFactor: 1, tick: 0.05 })).toBe(73.3);
    expect(premiumStop({ entryPremium: 500, loss: 4000, lotQty: 1, valueFactor: 100, tick: 0.5 })).toBe(460);
    expect(premiumStop({ entryPremium: 10, loss: 5000, lotQty: 75, valueFactor: 1, tick: 0.05 })).toBe(0.05);
  });
});

describe('ceilingFor', () => {
  it('classes as loss-limit, OTHER ⇒ 0 (refuse)', () => {
    expect(ceilingFor('NIFTY', 'NFO', 'NIFTY02DEC2626000CE', cfg)).toBe(5000);
    expect(ceilingFor('GOLD', 'MCX', 'GOLD26DEC26FUT', cfg)).toBe(7500);
    expect(ceilingFor('GOLDM', 'MCX', 'GOLDM05DEC26FUT', cfg)).toBe(4000);
    expect(ceilingFor('CRUDEOIL', 'MCX', 'CRUDEOIL16DEC26FUT', cfg)).toBe(5000);
    expect(ceilingFor('RELIANCE', 'NSE', 'RELIANCE-EQ', cfg)).toBe(0);
  });

  it('a mini without its own key reads the metal', () => {
    expect(ceilingFor('GOLDM', 'MCX', 'GOLDM05DEC26FUT', { ceilings: { GOLD: 7500 } })).toBe(7500);
  });
});

describe('pickContractSpec', () => {
  const today = new Date(2026, 10, 26, 10, 0);
  const row = (expiry: string, strike: number, kind: 'CE' | 'PE') => ({
    exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'OPTIDX', symbol: `NIFTY${expiry}${strike}${kind}`, expiry, strike: String(strike * 100),
  });
  const master = [
    ...[25900, 26000, 26100].flatMap((s) => [row('26NOV2026', s, 'CE'), row('02DEC2026', s, 'CE'), row('09DEC2026', s, 'CE'), row('02DEC2026', s, 'PE')]),
    { exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'FUTIDX', symbol: 'NIFTY30DEC26FUT', expiry: '30DEC2026', strike: '-1' },
  ];
  const base = { underlying: 'NIFTY', side: 'BUY_CE' as const, strikePolicy: 'ATM' as const, expiryPolicy: 'NEAREST' as const, spot: 26020 };

  it('ATM of the nearest expiry after today (never the expiry-day contract)', () => {
    expect(pickContractSpec(master, base, today)).toEqual({ ok: true, strike: 26000, expiry: '2026-12-02' });
  });
  it('NEXT expiry', () => {
    expect(pickContractSpec(master, { ...base, expiryPolicy: 'NEXT' }, today)).toEqual({ ok: true, strike: 26000, expiry: '2026-12-09' });
  });
  it('ITM1 / OTM1 by side', () => {
    expect(pickContractSpec(master, { ...base, strikePolicy: 'ITM1' }, today)).toMatchObject({ strike: 25900 });
    expect(pickContractSpec(master, { ...base, strikePolicy: 'OTM1' }, today)).toMatchObject({ strike: 26100 });
    expect(pickContractSpec(master, { ...base, side: 'BUY_PE', strikePolicy: 'ITM1' }, today)).toMatchObject({ strike: 26100 });
  });
  it('a numeric strike must be listed', () => {
    expect(pickContractSpec(master, { ...base, strikePolicy: 26100 }, today)).toMatchObject({ ok: true, strike: 26100 });
    expect(pickContractSpec(master, { ...base, strikePolicy: 26050 }, today).ok).toBe(false);
  });
  it('futures: expiry only', () => {
    expect(pickContractSpec(master, { ...base, side: 'BUY_FUT' }, today)).toEqual({ ok: true, strike: null, expiry: '2026-12-30' });
  });
});
