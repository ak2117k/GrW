/**
 * Golden tests for the MCX contract value factor (2026-11-04): every rupee computation that was
 * Δprice × qty must be Δprice × qty × factor, where qty is the broker netqty / lots × master lotSize.
 * MCX GOLD: master lotSize 1, quoted per 10 g, 1 kg lot → ₹100 per point per lot.
 */
import { contractValueFactor, mcxUnderlyingOf } from '@td/shared';
import { computeOrderCharges } from '../../modules/trade-engine/services/trade-charges';
import { estimateCharges, computeGreenFloor } from '../../modules/trade-sentinel/charges';
import { pnlArithmetic } from '../../modules/sanity-audit/domain/checks';
import { requiredFunds } from '../../modules/signal-trader/domain/funds';
import { grossPnl } from '../../modules/signal-trader/domain/exit-shadow';
import { computePnl, computeTickPatch } from '../../modules/trade-tracker/services/trade-tracker.service';

describe('contractValueFactor', () => {
  it.each([
    ['MCX', 'GOLD05DEC26FUT', 100],
    ['MCX', 'GOLD26NOV26120000CE', 100],
    ['MCX', 'GOLDM05DEC26FUT', 0.1],
    ['MCX', 'GOLDGUINEA28NOV26FUT', 0.125],
    ['MCX', 'GOLDPETAL28NOV26FUT', 1],
    ['MCX', 'SILVER05DEC26FUT', 1],
    ['MCX', 'SILVERM28NOV26FUT', 1],
    ['MCX', 'SILVER10028NOV26FUT', 0.1],
    ['MCX', 'CRUDEOIL19NOV26FUT', 1],
    ['MCX', 'CRUDEOILM19NOV26FUT', 1],
    ['MCX', 'ZINC28NOV26FUT', 1000],
    ['MCX', 'ZINCMINI28NOV26FUT', 1000],
    ['MCX', 'GOLD', 100],
    ['NFO', 'NIFTY25NOV26FUT', 1],
    ['NFO', 'GOLDBEES', 1],
    ['NSE', 'GOLDBEES-EQ', 1],
    ['BFO', 'SENSEX26NOV2680000CE', 1],
    [null, 'GOLD05DEC26FUT', 1],
  ] as const)('%s %s → %s', (exchange, symbol, f) => {
    expect(contractValueFactor(exchange, symbol)).toBe(f);
  });

  it('never lets GOLD swallow GOLDM / GOLDGUINEA, nor SILVER swallow SILVER100', () => {
    expect(mcxUnderlyingOf('GOLDM05DEC26FUT')).toBe('GOLDM');
    expect(mcxUnderlyingOf('GOLDGUINEA28NOV26FUT')).toBe('GOLDGUINEA');
    expect(mcxUnderlyingOf('SILVER10028NOV26FUT')).toBe('SILVER100');
    expect(mcxUnderlyingOf('GOLDX')).toBeNull();
  });

  it('an unknown MCX contract falls back to 1 (warned once)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(contractValueFactor('MCX', 'COTTONCANDY28NOV26FUT')).toBe(1);
    expect(contractValueFactor('MCX', 'COTTONCANDY28DEC26FUT')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('golden rupees per contract', () => {
  it('trade-tracker P&L: GOLD +100 pts on 1 lot (qty 1) = ₹10,000; GOLDM 1 lot (qty 100) = ₹1,000; ZINC +1 on qty 5 = ₹5,000', () => {
    expect(computePnl(120000, 120100, 1, contractValueFactor('MCX', 'GOLD05DEC26FUT')).pnl).toBe(10000);
    expect(computePnl(120000, 120100, 100, contractValueFactor('MCX', 'GOLDM05DEC26FUT')).pnl).toBeCloseTo(1000, 6);
    expect(computePnl(280, 281, 5, contractValueFactor('MCX', 'ZINC28NOV26FUT')).pnl).toBe(5000);
    // unchanged outside MCX and for MCX contracts whose quote unit = lot unit
    expect(computePnl(24000, 24010, 75, contractValueFactor('NFO', 'NIFTY25NOV26FUT')).pnl).toBe(750);
    expect(computePnl(6000, 6010, 100, contractValueFactor('MCX', 'CRUDEOIL19NOV26FUT')).pnl).toBe(1000);
  });

  it('trade-tracker tick patch reads the factor off the row', () => {
    const base = { entryPrice: 120000, qty: 1, holdingHigh: null, holdingLow: null, dayHigh: null, dayLow: null, dayDate: null };
    expect(computeTickPatch({ ...base, exchange: 'MCX', symbol: 'GOLD05DEC26FUT' } as any, 119900).pnl).toBe(-10000);
    expect(computeTickPatch({ ...base, exchange: 'NFO', symbol: 'NIFTY25NOV26FUT' } as any, 119900).pnl).toBe(-100);
  });

  it('signal shadow gross P&L', () => {
    expect(grossPnl('BUY', 120000, 120050, 1, 100)).toBe(5000);
    expect(grossPnl('SELL', 120000, 120050, 1, 100)).toBe(-5000);
    expect(grossPnl('BUY', 100, 110, 75)).toBe(750);
  });

  it('paper order charges: GOLD qty 1 is charged like ₹100 × price turnover', () => {
    const gold = computeOrderCharges({ side: 'SELL', price: 120000, quantity: 1, exchange: 'MCX', symbol: 'GOLD05DEC26FUT' });
    const sameTurnover = computeOrderCharges({ side: 'SELL', price: 120000, quantity: 100, exchange: 'MCX' });
    expect(gold.total).toBe(sameTurnover.total);
    const noSymbol = computeOrderCharges({ side: 'SELL', price: 120000, quantity: 1, exchange: 'MCX' });
    expect(noSymbol.total).toBeLessThan(gold.total);
  });

  it('sentinel charges + green floor scale turnover and rupees per point', () => {
    const a = estimateCharges({ segment: 'FUT', entryPrice: 120000, exitPrice: 120100, qty: 1, side: 'LONG', valueFactor: 100 });
    const b = estimateCharges({ segment: 'FUT', entryPrice: 120000, exitPrice: 120100, qty: 100, side: 'LONG' });
    expect(a).toBeCloseTo(b, 6);
    const g = computeGreenFloor({ segment: 'FUT', entryPrice: 120000, ltp: 120100, qty: 1, side: 'LONG', valueFactor: 100 });
    expect(g.netPnl).toBeCloseTo(10000 - a, 6);
    expect(g.armed).toBe(true);
  });

  it('sanity PNL_ARITHMETIC: a scaled GOLD close passes, an unscaled (pre-fix) one is flagged', () => {
    const row = { tradeId: 't1', symbol: 'GOLD05DEC26FUT', exchange: 'MCX', side: 'BUY', quantity: 1, entryPrice: 120000, exitPrice: 120100, exitAt: new Date(), partialExits: 0 };
    expect(pnlArithmetic({ ...row, pnl: 10000 })).toBeNull();
    expect(pnlArithmetic({ ...row, pnl: 100 })).not.toBeNull();
    expect(pnlArithmetic({ ...row, exchange: 'NFO', symbol: 'NIFTY25NOV26FUT', pnl: 100 })).toBeNull();
  });

  it('funds for an MCX GOLD option BUY: premium × qty × 100 + buffer', () => {
    const cfg = { fundsBufferPct: 1, futMarginPct: 25 };
    const r = requiredFunds({ side: 'BUY', limitPrice: 500, qty: 1, exchange: 'MCX', tradingsymbol: 'GOLD26NOV26120000CE' }, { instrumentKind: 'CE', strike: 120000 }, cfg);
    expect(r.required).toBe(50500);
    expect(r.method).toBe('premium');
    const nifty = requiredFunds({ side: 'BUY', limitPrice: 100, qty: 75, exchange: 'NFO', tradingsymbol: 'NIFTY25NOV2624000CE' }, { instrumentKind: 'CE', strike: 24000 }, cfg);
    expect(nifty.required).toBe(7575);
    const est = requiredFunds({ side: 'BUY', limitPrice: 120000, qty: 1, exchange: 'MCX', tradingsymbol: 'GOLD05DEC26FUT' }, { instrumentKind: 'FUT', strike: null }, cfg);
    expect(est.required).toBeCloseTo(120000 * 100 * 0.25 * 1.01, 2);
  });
});
