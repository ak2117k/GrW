import { chainBlockValue, mcxChainSnapshot, mcxExpiryOrder, parityFuture, underlyingFutureFor, type McxOiRow } from './mcx-chain';

describe('mcxExpiryOrder — MCX monthly option expiries', () => {
  const expiries = ['2026-11-17', '2026-12-16', '2027-01-14'];

  it('nearest live expiry when no traded one is given', () => {
    expect(mcxExpiryOrder(expiries, '2026-11-10')).toEqual(['2026-11-17']);
  });

  it('the traded expiry first, then the nearest', () => {
    expect(mcxExpiryOrder(expiries, '2026-11-10', '2026-12-16')).toEqual(['2026-12-16', '2026-11-17']);
    expect(mcxExpiryOrder(expiries, '2026-11-10', '2026-11-17')).toEqual(['2026-11-17']);
  });

  it('on the nearest expiry\'s own day the next month is the default', () => {
    expect(mcxExpiryOrder(expiries, '2026-11-17')).toEqual(['2026-12-16']);
    // ...unless the trade is on the expiring contract itself
    expect(mcxExpiryOrder(expiries, '2026-11-17', '2026-11-17')).toEqual(['2026-11-17', '2026-12-16']);
  });

  it('past expiries are dropped; an unlisted / futures expiry is ignored', () => {
    expect(mcxExpiryOrder(['2026-10-16', ...expiries], '2026-11-10', '2026-11-19')).toEqual(['2026-11-17']);
    expect(mcxExpiryOrder([], '2026-11-10', '2026-11-17')).toEqual([]);
  });

  it('a lone expiring expiry is still read on its day', () => {
    expect(mcxExpiryOrder(['2026-11-17'], '2026-11-17')).toEqual(['2026-11-17']);
  });
});

describe('underlyingFutureFor — an MCX option is written on the future expiring on or after it', () => {
  const futures = [
    { symbol: 'CRUDEOIL26NOVFUT', expiry: '2026-11-19' },
    { symbol: 'CRUDEOIL26DECFUT', expiry: '2026-12-18' },
  ];
  it('Nov options → Nov future (it expires two days after them)', () => {
    expect(underlyingFutureFor('2026-11-17', futures)?.symbol).toBe('CRUDEOIL26NOVFUT');
  });
  it('Dec options → Dec future, even while the Nov future is still the nearest', () => {
    expect(underlyingFutureFor('2026-12-16', futures)?.symbol).toBe('CRUDEOIL26DECFUT');
  });
  it('null when no future expires on or after the option', () => {
    expect(underlyingFutureFor('2027-01-14', futures)).toBeNull();
  });
  it('order of the input does not matter', () => {
    expect(underlyingFutureFor('2026-11-17', [...futures].reverse())?.symbol).toBe('CRUDEOIL26NOVFUT');
  });
});

describe('parityFuture', () => {
  it('F ≈ K + CE − PE at the strike where CE and PE are closest', () => {
    expect(
      parityFuture([
        { strike: 5400, ce: 220, pe: 90 },
        { strike: 5500, ce: 160, pe: 130 },
        { strike: 5600, ce: 110, pe: 180 },
      ]),
    ).toBe(5530);
  });
  it('null without a priced CE/PE pair', () => {
    expect(parityFuture([{ strike: 5500, ce: 160, pe: null }, { strike: 5600, ce: 0, pe: 100 }])).toBeNull();
  });
});

describe('mcxChainSnapshot — the NSE snapshot row from the hub capture', () => {
  const AT = new Date('2026-11-10T09:00:00Z');
  const strikes = [5200, 5300, 5400, 5500, 5600, 5700, 5800];
  const contracts = strikes.flatMap((k) => [
    { instrumentId: `${k}CE`, strike: k, optionType: 'CE' as const },
    { instrumentId: `${k}PE`, strike: k, optionType: 'PE' as const },
  ]);
  // OI: a put wall at 5400, a call wall at 5700; CE LTP falls / PE LTP rises with the strike (F ≈ 5530).
  const ceOi: Record<number, number> = { 5200: 100, 5300: 200, 5400: 300, 5500: 800, 5600: 900, 5700: 2000, 5800: 700 };
  const peOi: Record<number, number> = { 5200: 400, 5300: 600, 5400: 2500, 5500: 900, 5600: 300, 5700: 100, 5800: 50 };
  const rows: McxOiRow[] = strikes.flatMap((k) => [
    { instrumentId: `${k}CE`, oi: ceOi[k], oiChange: 50, volume: 10, ltp: Math.max(5, 160 - (k - 5500) * 0.6) },
    { instrumentId: `${k}PE`, oi: peOi[k], oiChange: null, volume: 10, ltp: Math.max(5, 130 + (k - 5500) * 0.6) },
  ]);

  it('centres on the future\'s 1-min close, windows ±N strikes, and computes PCR / max pain / walls', () => {
    const r = mcxChainSnapshot({ underlying: 'CRUDEOIL', expiry: '2026-11-17', capturedAt: AT, contracts, rows, futBar: 5510, strikesAround: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.futSource).toBe('candles_1m');
    expect(r.fut).toBe(5510);
    expect(r.row.spot).toBe(5510);
    expect(r.row.strikes.map((s) => s.strike)).toEqual([5300, 5400, 5500, 5600, 5700]);
    expect(r.strikes).toBe(5);
    expect(r.row.callWall).toBe(5700);
    expect(r.row.putWall).toBe(5400);
    const ce = 200 + 300 + 800 + 900 + 2000;
    const pe = 600 + 2500 + 900 + 300 + 100;
    expect(r.row.pcr).toBeCloseTo(pe / ce, 10);
    expect(r.row.maxPain).not.toBeNull();
    // oi_chg from the hub's own baseline (oi − oiChange); null where the capture had no baseline
    const atm = r.row.strikes.find((s) => s.strike === 5500)!;
    expect(atm.ce).toMatchObject({ ltp: 160, oi: 800, oi_chg: 50, vol: 10 });
    expect(atm.pe).toMatchObject({ ltp: 130, oi: 900, oi_chg: null });
  });

  it('falls back to put-call parity from the capture when the future has no bar', () => {
    const r = mcxChainSnapshot({ underlying: 'CRUDEOIL', expiry: '2026-11-17', capturedAt: AT, contracts, rows, futBar: null, strikesAround: 1 });
    expect(r.ok && r.futSource).toBe('parity');
    expect(r.ok && r.row.strikes.map((s) => s.strike)).toEqual([5400, 5500, 5600]);
  });

  it('a strike window far from the money is never centred on a spot index: ATM moves with the future', () => {
    const r = mcxChainSnapshot({ underlying: 'CRUDEOIL', expiry: '2026-11-17', capturedAt: AT, contracts, rows, futBar: 5790, strikesAround: 1 });
    expect(r.ok && r.row.strikes.map((s) => s.strike)).toEqual([5700, 5800]);
  });

  it('no row when nothing of the expiry was captured', () => {
    const r = mcxChainSnapshot({ underlying: 'CRUDEOILM', expiry: '2026-11-17', capturedAt: AT, contracts, rows: [], futBar: 5500 });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no captured legs') });
  });

  it('no row when no future price can be found', () => {
    const onlyCalls = rows.filter((x) => x.instrumentId.endsWith('CE'));
    const r = mcxChainSnapshot({ underlying: 'CRUDEOIL', expiry: '2026-11-17', capturedAt: AT, contracts, rows: onlyCalls, futBar: null });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no price') });
  });
});

describe('chainBlockValue — one packet shape for NSE and MCX', () => {
  it('carries the age in minutes and the fixed field set', () => {
    const now = new Date('2026-11-10T09:30:00Z');
    const v = chainBlockValue({ expiry: '2026-11-17', capturedAt: new Date('2026-11-10T09:00:00Z'), spot: 5510, pcr: 1.2, maxPain: 5500, callWall: 5700, putWall: 5400 }, now);
    expect(v).toEqual({ expiry: '2026-11-17', capturedAt: '2026-11-10T09:00:00.000Z', ageMin: 30, spot: 5510, fut: null, pcr: 1.2, maxPain: 5500, callWall: 5700, putWall: 5400 });
  });
});
