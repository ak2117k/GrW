import { GreeksCalculatorService } from '../../options-chain/services/greeks-calculator.service';
import type { QuoteOutcome } from '../quote-batcher';
import type { ChainContract } from './chain.types';
import { assembleEntries, pickStrikes, RISK_FREE_RATE } from './chain-math';
import { expiryCloseAt } from './chain-dates';

const contract = (strike: number, side: 'CE' | 'PE', token = `${side}${strike}`): ChainContract => ({
  instrumentId: `id-${token}`,
  ref: { exchange: 'NFO', token, symbol: `NIFTY13OCT26${strike}${side}` },
  strike,
  optionType: side,
  lotSize: 75,
});
const strikes = (from: number, to: number, step: number) => {
  const out: ChainContract[] = [];
  for (let s = from; s <= to; s += step) out.push(contract(s, 'CE'), contract(s, 'PE'));
  return out;
};
const ok = (ltp: number, oi?: number, bid?: number, ask?: number): QuoteOutcome => ({
  kind: 'ok',
  tick: {
    token: 'x', symbol: 'x', ltp, open: 0, high: 0, low: 0, close: 0, volume: 7, oi, timestamp: new Date(),
    depth: bid && ask ? { bids: [{ price: bid, qty: 75, orders: 1 }], asks: [{ price: ask, qty: 75, orders: 1 }] } : undefined,
  },
});
const NOW = Date.parse('2026-10-12T05:00:00Z'); // 10:30 IST, a day before expiry

describe('pickStrikes', () => {
  const all = strikes(24000, 26000, 50); // 41 strikes, 82 contracts
  it('takes n strikes each side of the strike nearest the centre (both sides of each strike)', () => {
    const picked = pickStrikes(all, 25012, 2);
    expect([...new Set(picked.map((c) => c.strike))]).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(picked).toHaveLength(10);
  });
  it('centres on the median listed strike when no centre is known', () => {
    const picked = pickStrikes(all, null, 1);
    expect([...new Set(picked.map((c) => c.strike))]).toEqual([24950, 25000, 25050]);
  });
  it('clips at the ends of the list', () => {
    expect(new Set(pickStrikes(all, 24000, 3).map((c) => c.strike)).size).toBe(4);
  });
});

describe('assembleEntries', () => {
  const math = new GreeksCalculatorService();
  const ce = contract(25000, 'CE');
  const pe = contract(25000, 'PE');
  const base = {
    contracts: [ce, pe],
    spot: 25010,
    expiry: '2026-10-13',
    exchange: 'NFO',
    now: NOW,
    math,
  };

  it('oiChange is null without a baseline and current − baseline with one', () => {
    const { entries } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map([['id-CE25000', 4200]]),
    });
    expect(entries[0].ceData?.oiChange).toBe(800);
    expect(entries[0].peData?.oiChange).toBeNull();
  });

  it('carries token, lot size, volume and L1 bid/ask; uses the broker Greeks when present', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000, 119.5, 120.5)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: [
        { strike: 25000, optionType: 'CE', iv: 13.4, delta: 0.52, gamma: 0.001, theta: -12, vega: 9 },
        { strike: 25000, optionType: 'PE', iv: 14.1, delta: -0.48, gamma: 0.001, theta: -11, vega: 9 },
      ],
      baseline: new Map(),
    });
    expect(greeks).toBe('broker');
    expect(entries[0]).toEqual({
      strikePrice: 25000,
      expiryDate: '2026-10-13',
      ceData: { ltp: 120, oi: 5000, oiChange: null, volume: 7, iv: 13.4, delta: 0.52, gamma: 0.001, theta: -12, vega: 9, bidPrice: 119.5, askPrice: 120.5, token: 'CE25000', lotSize: 75 },
      peData: expect.objectContaining({ ltp: 110, iv: 14.1, bidPrice: 0, askPrice: 0, token: 'PE25000' }),
    });
  });

  it('computes IV and Greeks locally from LTP when a leg has no broker row, and says so', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(greeks).toBe('local');
    expect(entries[0].ceData!.iv).toBeGreaterThan(1); // percent, not a decimal
    expect(entries[0].ceData!.iv).not.toBe(15);
    expect(entries[0].ceData!.delta).toBeGreaterThan(0);
    expect(entries[0].peData!.delta).toBeLessThan(0);
  });

  it('leaves a leg null when its quote did not come back, and Greeks zero without a spot (label none)', () => {
    const { entries, quotedLegs, greeks } = assembleEntries({
      ...base,
      spot: null,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', { kind: 'throttled', retryAfterMs: 1000 }]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(quotedLegs).toBe(1);
    expect(entries[0].peData).toBeNull();
    expect(entries[0].ceData).toEqual(expect.objectContaining({ ltp: 120, iv: 0, delta: 0 }));
    expect(greeks).toBe('none');
  });

  it('labels none after the expiry close (t = 0) when no broker row was used', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      now: Date.parse('2026-10-13T12:00:00Z'), // 17:30 IST on expiry day
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(greeks).toBe('none');
    expect(entries[0].ceData).toEqual(expect.objectContaining({ iv: 0, delta: 0 }));
  });

  it('labels local on a mixed chain: broker row for CE, none for PE with a spot', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: [{ strike: 25000, optionType: 'CE', iv: 13.4, delta: 0.52, gamma: 0.001, theta: -12, vega: 9 }],
      baseline: new Map(),
    });
    expect(greeks).toBe('local');
    expect(entries[0].ceData!.iv).toBe(13.4);
    expect(entries[0].peData!.iv).toBeGreaterThan(1);
    expect(entries[0].peData!.delta).toBeLessThan(0);
  });

  it('gives a leg priced below intrinsic no IV and does not count it as local', () => {
    const itm = contract(24000, 'CE');
    const { entries, greeks } = assembleEntries({
      ...base,
      contracts: [itm],
      quotes: new Map([['NFO:CE24000', ok(5, 100)]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(entries[0].ceData).toEqual(expect.objectContaining({ ltp: 5, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 }));
    expect(greeks).toBe('none');
  });

  it('treats an IV at the solver ceiling as non-converged (zero Greeks, label none)', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      contracts: [ce],
      quotes: new Map([['NFO:CE25000', ok(5000, 100)]]), // ~20% of spot for an ATM weekly: IV clamps at 5.0
      greeks: null,
      baseline: new Map(),
    });
    expect(entries[0].ceData).toEqual(expect.objectContaining({ iv: 0, delta: 0 }));
    expect(greeks).toBe('none');
  });

  it('stores the local IV in percent: it reprices to the LTP', () => {
    const { entries } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map(),
    });
    const t = (expiryCloseAt('2026-10-13', 'NFO').getTime() - NOW) / (365.25 * 24 * 60 * 60 * 1000);
    const ceIv = entries[0].ceData!.iv / 100;
    const peIv = entries[0].peData!.iv / 100;
    expect(Math.abs(math.blackScholesPrice(25010, 25000, t, RISK_FREE_RATE, ceIv, 'CE') - 120)).toBeLessThan(0.5);
    expect(Math.abs(math.blackScholesPrice(25010, 25000, t, RISK_FREE_RATE, peIv, 'PE') - 110)).toBeLessThan(0.5);
  });
});
