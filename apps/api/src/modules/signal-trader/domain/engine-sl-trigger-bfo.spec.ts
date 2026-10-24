import { deriveEngineSl, longUnderlying, type EngineSlInput } from './engine-sl';
import { entryNotReached, judgeFresh, readTrigger, triggerExpiry, triggerHit, triggerOf } from './trigger';
import { marginPosition, needsMargin, parseMarginResponse, requiredFunds } from './funds';
import { resolveContract, segmentFor } from './contract-resolver';
import { keepMasterRow } from '../../market-data/services/master-contract';
import { listedExpiries, findContract, segmentOf } from '../../signal-intake/domain/contract';
import { inferExpiry } from '../../signal-intake/domain/expiry';
import { atr14 } from '../services/signal-context.service';
import type { SignalView } from './signal.types';

const opt = (o: Partial<EngineSlInput> = {}): EngineSlInput => ({
  kind: 'CE', side: 'BUY', price: 100, tick: 0.05, spot: 25000, support: 24900, resistance: 25100, delta: 0.5, atr: null, optionPct: 25, bufferPct: 0.1, ...o,
});

describe('deriveEngineSl', () => {
  it('long underlying vs short', () => {
    expect(longUnderlying('CE', 'BUY')).toBe(true);
    expect(longUnderlying('PE', 'BUY')).toBe(false);
    expect(longUnderlying('PE', 'SELL')).toBe(true);
    expect(longUnderlying('FUT', 'SELL')).toBe(false);
  });

  it('BUY CE: support − buffer, move × delta off the premium', () => {
    const r = deriveEngineSl(opt());
    // stop 24900 × 0.999 = 24875.1 → move 124.9 × 0.5 = 62.45 → 37.55
    expect(r).toMatchObject({ method: 'level_delta' });
    expect(r.sl).toBeCloseTo(37.55, 2);
  });

  it('BUY PE uses the resistance above', () => {
    const r = deriveEngineSl(opt({ kind: 'PE', delta: -0.4 }));
    // 25100 × 1.001 = 25125.1 → move 125.1 × 0.4 = 50.04 → 49.96 → floor tick 49.95
    expect(r).toMatchObject({ method: 'level_delta', sl: 49.95 });
  });

  it('option without delta or level → premium % stop', () => {
    expect(deriveEngineSl(opt({ delta: null }))).toMatchObject({ method: 'premium_pct', sl: 75 });
    expect(deriveEngineSl(opt({ support: null }))).toMatchObject({ method: 'premium_pct', sl: 75 });
    expect(deriveEngineSl(opt({ spot: null }))).toMatchObject({ method: 'premium_pct', sl: 75 });
  });

  it('level/delta stop below zero falls back to the % stop', () => {
    expect(deriveEngineSl(opt({ support: 23000 }))).toMatchObject({ method: 'premium_pct', sl: 75 });
  });

  it('a level on the wrong side of spot is not protective', () => {
    expect(deriveEngineSl(opt({ support: 25050 })).method).toBe('premium_pct');
  });

  it('FUT: the underlying move applied to the future; else 1×ATR; else none', () => {
    const f = { kind: 'FUT' as const, price: 25100, tick: 0.1, delta: null };
    expect(deriveEngineSl(opt(f))).toMatchObject({ method: 'level_fut', sl: 24975.1 });
    expect(deriveEngineSl(opt({ ...f, support: null, atr: 180 }))).toMatchObject({ method: 'atr', sl: 24920 });
    expect(deriveEngineSl(opt({ ...f, side: 'SELL', resistance: null, atr: 180 }))).toMatchObject({ method: 'atr', sl: 25280 });
    expect(deriveEngineSl(opt({ ...f, support: null, atr: null })).sl).toBeNull();
  });

  it('EQ: the level itself with the buffer', () => {
    const r = deriveEngineSl(opt({ kind: 'EQ', price: 500, spot: 500, support: 490, delta: null }));
    expect(r).toMatchObject({ method: 'level', sl: 489.5 });
    expect(deriveEngineSl(opt({ kind: 'EQ', price: 500, spot: 500, support: null })).sl).toBeNull();
  });
});

describe('pending trigger domain', () => {
  const s = { entryType: 'ABOVE' as const, entryLow: 100, entryHigh: 100 };
  it('only ABOVE / BELOW wait, and only before the band', () => {
    expect(entryNotReached(s, 95, 3)).toBe(true);
    expect(entryNotReached(s, 101, 3)).toBe(false);
    expect(entryNotReached(s, 110, 3)).toBe(false); // chasing is not "not reached"
    expect(entryNotReached({ ...s, entryType: 'BELOW' }, 105, 3)).toBe(true);
    expect(entryNotReached({ ...s, entryType: 'AT' }, 95, 3)).toBe(false);
  });
  it('band: ABOVE [x, x·1.03], BELOW [x·0.97, x]', () => {
    expect(triggerOf(s, 3)).toEqual({ op: 'ABOVE', price: 100, bandLow: 100, bandHigh: 103 });
    expect(triggerOf({ ...s, entryType: 'BELOW' }, 3)).toEqual({ op: 'BELOW', price: 100, bandLow: 97, bandHigh: 100 });
    expect(triggerHit({ bandLow: 100, bandHigh: 103 }, 103)).toBe(true);
    expect(triggerHit({ bandLow: 100, bandHigh: 103 }, 103.5)).toBe(false);
    expect(triggerHit({ bandLow: 100, bandHigh: 103 }, null)).toBe(false);
  });
  it('expiry: wait minutes, capped by the close cutoff; none when no time is left', () => {
    const at = new Date('2026-10-26T05:00:00Z');
    expect(triggerExpiry(at, 30, 300, 20)?.getTime()).toBe(at.getTime() + 30 * 60_000);
    expect(triggerExpiry(at, 30, 35, 20)?.getTime()).toBe(at.getTime() + 15 * 60_000);
    expect(triggerExpiry(at, 30, 20, 20)).toBeNull();
    expect(triggerExpiry(at, 0, 300, 20)).toBeNull();
  });
  it('judge reuse window and a malformed stored trigger', () => {
    const now = new Date('2026-10-26T05:10:00Z');
    expect(judgeFresh('2026-10-26T05:01:00Z', now, 10)).toBe(true);
    expect(judgeFresh('2026-10-26T04:59:00Z', now, 10)).toBe(false);
    expect(judgeFresh(null, now, 10)).toBe(false);
    expect(readTrigger({ trigger: { price: 1 } })).toBeNull();
    expect(readTrigger({ trigger: { price: 100, op: 'ABOVE', bandLow: 100, bandHigh: 103, armedAt: 'a', expiresAt: '2026-10-26T05:30:00Z' } })).toMatchObject({ price: 100, judgedAt: null });
  });
});

describe('broker margin (SmartAPI marginApi)', () => {
  const cfg = { fundsBufferPct: 1, futMarginPct: 25 };
  it('parses the batch answer; anything else is a named failure', () => {
    expect(parseMarginResponse({ status: true, message: 'SUCCESS', data: { totalMarginRequired: 123456.789, marginComponents: {} } })).toEqual({ ok: true, margin: 123456.79 });
    expect(parseMarginResponse({ status: false, message: 'Invalid Token', errorcode: 'AG8001' })).toMatchObject({ ok: false, reason: 'broker: Invalid Token' });
    expect(parseMarginResponse({})).toMatchObject({ ok: false });
    expect(parseMarginResponse(null)).toMatchObject({ ok: false });
    expect(parseMarginResponse({ status: true, data: { totalMarginRequired: 0 } })).toMatchObject({ ok: false });
  });
  it('broker figure → method broker; failure → estimate, saying why', () => {
    const plan = { side: 'BUY' as const, limitPrice: 25000, qty: 75 };
    expect(requiredFunds(plan, { instrumentKind: 'FUT', strike: null }, cfg, { ok: true, margin: 150000 })).toMatchObject({ method: 'broker', required: 151500 });
    const est = requiredFunds(plan, { instrumentKind: 'FUT', strike: null }, cfg, { ok: false, reason: 'timeout' });
    expect(est.method).toBe('estimate');
    expect(est.detail).toMatch(/broker margin unavailable: timeout/);
  });
  it('who needs margin, and the position shape', () => {
    expect(needsMargin('BUY', 'FUT')).toBe(true);
    expect(needsMargin('SELL', 'CE')).toBe(true);
    expect(needsMargin('BUY', 'PE')).toBe(false);
    expect(needsMargin('BUY', 'EQ')).toBe(false);
    const p = { exchange: 'MCX', token: '9', side: 'SELL' as const, limitPrice: 6000, qty: 100, lots: 1 };
    expect(marginPosition(p, 'INTRADAY', 'lots')).toEqual({ exchange: 'MCX', qty: 1, price: 6000, productType: 'INTRADAY', token: '9', tradeType: 'SELL', orderType: 'LIMIT' });
    expect(marginPosition(p, 'CARRYFORWARD', 'units').qty).toBe(100);
  });
});

describe('BFO (SENSEX / BANKEX F&O)', () => {
  const today = new Date(2026, 9, 26);
  const row = (o: Record<string, unknown>) => ({ token: '1', symbol: 'X', name: 'SENSEX', expiry: '30OCT2026', strike: '8000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5', ...o });

  it('the cached master keeps SENSEX/BANKEX BFO within 70 days only; NFO/MCX/NSE/BSE in full', () => {
    expect(keepMasterRow(row({}), today)).toBe(true);
    expect(keepMasterRow(row({ name: 'BANKEX' }), today)).toBe(true);
    expect(keepMasterRow(row({ name: 'RELIANCE' }), today)).toBe(false);
    expect(keepMasterRow(row({ expiry: '25JUN2027' }), today)).toBe(false);
    expect(keepMasterRow(row({ expiry: '23OCT2026' }), today)).toBe(false);
    expect(keepMasterRow(row({ exch_seg: 'NFO', name: 'ANY', expiry: '' }), today)).toBe(true);
    expect(keepMasterRow(row({ exch_seg: 'CDS' }), today)).toBe(false);
  });

  it('signal-trader resolves the nearest SENSEX weekly from the master on BFO', () => {
    expect(segmentFor({ underlying: 'SENSEX', instrumentKind: 'CE' })).toBe('BFO');
    const master = [
      row({ token: 'a', symbol: 'SENSEX2610308000CE', expiry: '30OCT2026' }),
      row({ token: 'b', symbol: 'SENSEX2611068000CE', expiry: '06NOV2026' }),
    ];
    const s = { underlying: 'SENSEX', instrumentKind: 'CE', strike: 80000, expiry: null } as unknown as SignalView;
    const r = resolveContract(master, s, today);
    expect(r).toMatchObject({ ok: true, contract: { exchange: 'BFO', token: 'a', lotSize: 20, tickSize: 0.05, expiry: '2026-10-30' } });
  });

  it('signal-intake prefers the master expiry and finds the BFO token (outcome replay)', () => {
    const master = [row({ token: 'a', symbol: 'SENSEX2610298000CE', expiry: '29OCT2026' })];
    expect(segmentOf('SENSEX', 'CE', undefined)).toBe('BFO');
    const listed = listedExpiries(master, 'SENSEX', 'CE', 'BFO');
    expect(listed).toEqual(['2026-10-29']);
    // master date (a holiday-shifted Wednesday) wins over the Thursday rule
    expect(inferExpiry('SENSEX', 'CE', null, new Date('2026-10-26T05:00:00Z'), listed)).toEqual({ expiry: '2026-10-29', source: 'master' });
    expect(findContract(master, { underlying: 'SENSEX', instrumentKind: 'CE', strike: 80000, expiry: '2026-10-29' }, 'BFO')).toEqual({ exchange: 'BFO', token: 'a', tradingsymbol: 'SENSEX2610298000CE' });
  });
});

describe('atr14', () => {
  it('simple mean true range of the last 14', () => {
    const bars = Array.from({ length: 20 }, (_, k) => ({ high: 110 + k, low: 100 + k, close: 105 + k }));
    expect(atr14(bars)).toBe(10);
    expect(atr14([{ high: 1, low: 1, close: 1 }])).toBeNull();
  });
});
