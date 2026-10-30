import { parseSignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { atmOption, ENGINE_PLAN, engineContract, engineSignal, planEngineEntry } from './engine-contract';

const row = (token: string, expiry: string, strike: number, kind: 'CE' | 'PE', name = 'NIFTY', seg = 'NFO', lot = '75') => ({
  token,
  symbol: `${name}${expiry.slice(0, 5)}${expiry.slice(7)}${strike}${kind}`,
  name,
  expiry,
  strike: String(strike * 100),
  lotsize: lot,
  instrumenttype: seg === 'MCX' ? 'OPTFUT' : 'OPTIDX',
  exch_seg: seg,
  tick_size: '5.000000',
});

const MASTER = [
  row('1', '30OCT2026', 23000, 'PE'), // expiry day: never picked
  row('2', '03NOV2026', 22950, 'PE'),
  row('3', '03NOV2026', 23000, 'PE'),
  row('4', '03NOV2026', 23050, 'PE'),
  row('5', '03NOV2026', 23000, 'CE'),
  row('6', '10NOV2026', 23000, 'PE'),
  row('7', '17NOV2026', 9650, 'PE', 'CRUDEOIL', 'MCX', '100'),
  row('8', '17NOV2026', 9700, 'PE', 'CRUDEOIL', 'MCX', '100'),
];
const TODAY = new Date(2026, 9, 30, 11, 0);

describe('atmOption', () => {
  it('nearest expiry AFTER today, strike nearest the spot', () => {
    expect(atmOption(MASTER, 'NIFTY', 'PE', 23_012, TODAY)).toEqual({ ok: true, strike: 23000, expiry: '2026-11-03' });
    expect(atmOption(MASTER, 'NIFTY', 'PE', 23_040, TODAY)).toEqual({ ok: true, strike: 23050, expiry: '2026-11-03' });
    expect(atmOption(MASTER, 'CRUDEOIL', 'PE', 9_660, TODAY)).toEqual({ ok: true, strike: 9650, expiry: '2026-11-17' });
  });
  it('refuses without a spot or without contracts', () => {
    expect(atmOption(MASTER, 'NIFTY', 'PE', 0, TODAY).ok).toBe(false);
    expect(atmOption(MASTER, 'SENSEX', 'CE', 74_000, TODAY).ok).toBe(false);
  });
});

describe('planEngineEntry', () => {
  it('a BUY at the LTP, 1 lot, premium-% SL and T1, through the signal-trader planEntry (paper: 1 lot even over the risk cap)', () => {
    const contract = engineContract(MASTER, { underlying: 'CRUDEOIL', instrumentKind: 'PE', strike: 9650, expiry: '2026-11-17' }, TODAY);
    expect(contract.ok).toBe(true);
    const signal = engineSignal({ decisionId: 'd1', underlying: 'CRUDEOIL', kind: 'PE', strike: 9650, expiry: '2026-11-17', ltp: 250, tick: 0.05, at: TODAY });
    expect(signal).toMatchObject({ side: 'BUY', entryType: 'AT', sl: 187.5, targets: [375], qty: ENGINE_PLAN.lots });
    const { plan, checks } = planEngineEntry({ signal, contract, ltp: 250, cfg: parseSignalTraderConfig({}) });
    expect(plan).toMatchObject({ exchange: 'MCX', token: '7', side: 'BUY', ltp: 250, lots: 1, qty: 100, sl: 187.5, targets: [375] });
    expect(plan?.learn).toBeUndefined();
    // ₹62.5 × 100 = ₹6,250 > the ₹2,000 cap: recorded as a warning, 1 lot anyway (paper).
    expect(checks.find((c) => c.name === 'risk_cap')).toMatchObject({ ok: false, required: false });
  });
});
