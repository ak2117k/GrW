import { mbmHorizonFor, mbmInstrumentFor, usableHorizon } from './mbm-applies';

describe('mbmInstrumentFor', () => {
  const I = ['NIFTY'];
  it.each([
    [{ symbol: 'NIFTY27OCT2625000CE', exchange: 'NFO' }, 'NIFTY'],
    [{ symbol: 'NIFTY26OCTFUT', exchange: 'NFO' }, 'NIFTY'],
    [{ symbol: 'NIFTY', exchange: 'NSE' }, 'NIFTY'],
    [{ symbol: 'BANKNIFTY27OCT2655000CE', exchange: 'NFO' }, null],
    [{ symbol: 'FINNIFTY27OCT2624000PE', exchange: 'NFO' }, null],
    [{ symbol: 'NIFTYNXT5027OCT2668000CE', exchange: 'NFO' }, null],
    [{ symbol: 'RELIANCE27OCT261270CE', exchange: 'NFO' }, null],
    [{ symbol: 'CRUDEOIL17NOV269000CE', exchange: 'MCX' }, null],
    [{ symbol: '', exchange: 'NFO' }, null],
  ])('%j → %s', (t, want) => expect(mbmInstrumentFor(t, I)).toBe(want));
  it('nothing applies when no instruments are enabled', () =>
    expect(mbmInstrumentFor({ symbol: 'NIFTY26OCTFUT', exchange: 'NFO' }, [])).toBeNull());
});

describe('mbmHorizonFor / usableHorizon', () => {
  it('picks 60m with an hour or more left, else 30m', () => {
    expect(mbmHorizonFor(61)).toBe('60m');
    expect(mbmHorizonFor(60)).toBe('60m');
    expect(mbmHorizonFor(59)).toBe('30m');
  });
  it('only an ok answer with a finite p is usable', () => {
    const h = { p: 0.8, regime: 'ACTIVE', q25Bp: 1, q50Bp: 2, q75Bp: 3 };
    expect(usableHorizon({ status: 'ok', horizons: { '30m': h } }, '30m')).toBe(h);
    expect(usableHorizon({ status: 'stale', horizons: { '30m': h } }, '30m')).toBeNull();
    expect(usableHorizon({ status: 'absent' }, '30m')).toBeNull();
    expect(usableHorizon({ status: 'ok', horizons: { '30m': { ...h, p: NaN } } }, '30m')).toBeNull();
    expect(usableHorizon(null, '30m')).toBeNull();
  });
});
