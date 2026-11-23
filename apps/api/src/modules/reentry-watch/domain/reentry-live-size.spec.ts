import { sizeLiveReentry, type LiveSizeInput } from './reentry-live-size';

const GOLD = 'GOLD05DEC26130000CE';
const GOLDM = 'GOLDM05DEC26130000CE';
const CRUDE = 'CRUDEOIL16DEC265400PE';
const CRUDEM = 'CRUDEOILM16DEC265400PE';

const nifty = (o: Partial<LiveSizeInput> = {}): LiveSizeInput => ({
  underlying: 'NIFTY', fullSymbol: 'NIFTY25NOV2624400CE', entry: 100, sl: 75, lotSize: 75, fundsOkFull: true, mini: null, riskCapRupees: 2000, miniMaxLots: 5, ...o,
});
const fundsUpTo = (n: number | null) => (lots: number) => (n === null ? null : lots <= n);
/** GOLD 1 lot: (200 − 150) × 1 × ₹100/pt = ₹5,000 > ₹2,000. GOLDM 1 lot: 50 × 100 × 0.1 = ₹500. */
const gold = (o: Partial<LiveSizeInput> = {}, miniFunds: number | null = 10): LiveSizeInput => ({
  underlying: 'GOLD', fullSymbol: GOLD, entry: 200, sl: 150, lotSize: 1, fundsOkFull: true,
  mini: { symbol: GOLDM, lotSize: 100, entry: 200, sl: 150, fundsOkLots: fundsUpTo(miniFunds) },
  riskCapRupees: 2000, miniMaxLots: 5, ...o,
});

describe('sizeLiveReentry', () => {
  it('full lot within ₹2,000 → FULL 1 lot (boundary: exactly ₹2,000 fits)', () => {
    expect(sizeLiveReentry(nifty())).toEqual({ kind: 'FULL', lots: 1, riskRupees: 1875 });
    expect(sizeLiveReentry(nifty({ lotSize: 80 }))).toEqual({ kind: 'FULL', lots: 1, riskRupees: 2000 });
  });

  it('NSE full lot over ₹2,000 → NONE RISK_OVER_LIMIT (no mini, never a fraction)', () => {
    const r = sizeLiveReentry(nifty({ lotSize: 81 }));
    expect(r).toMatchObject({ kind: 'NONE', limit: 'RISK_OVER_LIMIT' });
    if (r.kind === 'NONE') expect(r.detail).toContain('₹2,025 > ₹2,000');
  });

  it('GOLD full lot uses the ₹100/pt value factor; over the cap → GOLDM lots = min(⌊2000/500⌋=4, funds, max)', () => {
    expect(sizeLiveReentry(gold())).toEqual({ kind: 'MINI', miniSymbol: GOLDM, lots: 4, riskRupees: 2000 });
    expect(sizeLiveReentry(gold({}, 3))).toEqual({ kind: 'MINI', miniSymbol: GOLDM, lots: 3, riskRupees: 1500 });
    expect(sizeLiveReentry(gold({ miniMaxLots: 2 }))).toEqual({ kind: 'MINI', miniSymbol: GOLDM, lots: 2, riskRupees: 1000 });
  });

  it('GOLD full lot fits risk and funds → FULL (the mini is not used)', () => {
    // (20 − 15) × 1 × 100 = ₹500.
    expect(sizeLiveReentry(gold({ entry: 20, sl: 15 }))).toEqual({ kind: 'FULL', lots: 1, riskRupees: 500 });
  });

  it('CRUDEOIL over → CRUDEOILM capped by miniMaxLots', () => {
    const r = sizeLiveReentry({
      underlying: 'CRUDEOIL', fullSymbol: CRUDE, entry: 100, sl: 75, lotSize: 100, fundsOkFull: true,
      mini: { symbol: CRUDEM, lotSize: 10, entry: 100, sl: 75, fundsOkLots: () => true }, riskCapRupees: 2000, miniMaxLots: 5,
    });
    // full ₹2,500 > ₹2,000; mini ₹250/lot → by risk 8, cap 5.
    expect(r).toEqual({ kind: 'MINI', miniSymbol: CRUDEM, lots: 5, riskRupees: 1250 });
  });

  it('SILVER over the cap → NONE RISK_OVER_LIMIT (no mini, even if one is passed)', () => {
    const r = sizeLiveReentry({
      underlying: 'SILVER', fullSymbol: 'SILVER05DEC26150000CE', entry: 400, sl: 300, lotSize: 30, fundsOkFull: true,
      mini: { symbol: 'SILVERM05DEC26150000CE', lotSize: 5, entry: 400, sl: 300, fundsOkLots: () => true }, riskCapRupees: 2000, miniMaxLots: 5,
    });
    expect(r).toMatchObject({ kind: 'NONE', limit: 'RISK_OVER_LIMIT' });
  });

  it('funds short on the full lot → mini when it fits; no mini → NO_FUNDS', () => {
    // GOLD (20 − 15) × 100 = ₹500 fits risk but not funds; GOLDM (20 − 15) × 10 = ₹50/lot, funds allow 2.
    const short = gold({ entry: 20, sl: 15, fundsOkFull: false, mini: { symbol: GOLDM, lotSize: 100, entry: 20, sl: 15, fundsOkLots: fundsUpTo(2) } });
    expect(sizeLiveReentry(short)).toEqual({ kind: 'MINI', miniSymbol: GOLDM, lots: 2, riskRupees: 100 });
    expect(sizeLiveReentry(nifty({ fundsOkFull: false }))).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
    expect(sizeLiveReentry(gold({ entry: 20, sl: 15, fundsOkFull: false, mini: null }))).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
  });

  it('funds unknown (null) is not a yes', () => {
    expect(sizeLiveReentry(nifty({ fundsOkFull: null }))).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
    expect(sizeLiveReentry(gold({}, null))).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
    const throwing = gold();
    throwing.mini!.fundsOkLots = () => {
      throw new Error('boom');
    };
    expect(sizeLiveReentry(throwing)).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
  });

  it('mini funds fit 0 lots → NO_FUNDS', () => {
    expect(sizeLiveReentry(gold({}, 0))).toMatchObject({ kind: 'NONE', limit: 'NO_FUNDS' });
  });

  it('mini 0 lots by risk (1 mini lot over the cap) → NO_SIZE', () => {
    // GOLD (1000 − 750) × 100 = ₹25,000; GOLDM 250 × 10 = ₹2,500 per lot > ₹2,000.
    const r = sizeLiveReentry(gold({ entry: 1000, sl: 750, mini: { symbol: GOLDM, lotSize: 100, entry: 1000, sl: 750, fundsOkLots: () => true } }));
    expect(r).toMatchObject({ kind: 'NONE', limit: 'NO_SIZE' });
  });

  it('never more than 1 full lot, whatever the room', () => {
    const r = sizeLiveReentry(nifty({ entry: 10, sl: 9, riskCapRupees: 2000 }));
    expect(r).toEqual({ kind: 'FULL', lots: 1, riskRupees: 75 });
  });

  it('unreadable numbers → NO_SIZE', () => {
    for (const o of [{ entry: Number.NaN }, { sl: 100 }, { sl: -1 }, { lotSize: 0 }, { lotSize: 1.5 }, { riskCapRupees: 0 }, { riskCapRupees: Number.NaN }, { fullSymbol: '' }] as Partial<LiveSizeInput>[]) {
      expect(sizeLiveReentry(nifty(o))).toMatchObject({ kind: 'NONE', limit: 'NO_SIZE' });
    }
    expect(sizeLiveReentry(gold({ miniMaxLots: 0 }))).toMatchObject({ kind: 'NONE', limit: 'NO_SIZE' });
  });

  it('a mini that is not the full contract\'s mini, or an unknown MCX symbol → NO_SIZE', () => {
    const wrong = gold();
    wrong.mini!.symbol = 'GOLDM27NOV26130000CE';
    expect(sizeLiveReentry(wrong)).toMatchObject({ kind: 'NONE', limit: 'NO_SIZE' });
    expect(sizeLiveReentry(gold({ fullSymbol: 'XAU05DEC26130000CE' }))).toMatchObject({ kind: 'NONE', limit: 'NO_SIZE' });
  });
});
