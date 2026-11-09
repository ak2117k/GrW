import { lossLimitFor, lossLimitForTrade, parseLossLimitsByUnderlying } from './loss-limit';
import { hardLossConfig, hardLossReading, hardLossTrip } from '../../modules/exit-discipline/hard-floor';

describe('lossLimitFor (HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING, 2026-11-04)', () => {
  const ENV = { HARD_LOSS_EXIT_RUPEES: '2000' };

  it('GOLD → {limit 7500, cap 7500} by the code default', () => {
    expect(lossLimitFor('GOLD', ENV)).toEqual({ limit: 7500, cap: 7500 });
  });

  it('GOLD tradingsymbols (futures and options) resolve to GOLD', () => {
    expect(lossLimitFor('GOLD27NOV26125000PE', ENV)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitFor('gold05dec26fut', ENV)).toEqual({ limit: 7500, cap: 7500 });
  });

  it('GOLDM, GOLDGUINEA, SILVER100 → the default {2000, 3000}', () => {
    expect(lossLimitFor('GOLDM', ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('GOLDM05DEC26FUT', ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('GOLDGUINEA28NOV26FUT', ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('SILVER100', ENV)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('GOLDBEES (NSE ETF) is not GOLD', () => {
    expect(lossLimitFor('GOLDBEES', ENV)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('NIFTY / null / empty → default', () => {
    expect(lossLimitFor('NIFTY', ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor(null, ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('', ENV)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('non-MCX names match upper-case exactly', () => {
    const env = { ...ENV, HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'banknifty:4000' };
    expect(lossLimitFor('BankNifty', env)).toEqual({ limit: 4000, cap: 4000 });
    expect(lossLimitFor('BANKNIFTY25NOV2650000CE', env)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('NIFTY', env)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('env "off" → defaults for all', () => {
    const env = { ...ENV, HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'off' };
    expect(lossLimitFor('GOLD', env)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('NIFTY', env)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('an explicit list replaces the code default', () => {
    const env = { ...ENV, HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'SILVER:5000' };
    expect(lossLimitFor('SILVER', env)).toEqual({ limit: 5000, cap: 5000 });
    expect(lossLimitFor('SILVERM', env)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('GOLD', env)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('junk entries are ignored, valid ones kept', () => {
    expect(parseLossLimitsByUnderlying('GOLD:7500, SILVER:abc ,:500,CRUDEOIL,NATURALGAS:-1,ZINC:0,COPPER:4000:1,LEAD : 2500')).toEqual({ GOLD: 7500, LEAD: 2500 });
    const env = { ...ENV, HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING: 'SILVER:abc,GOLD:7500' };
    expect(lossLimitFor('SILVER', env)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('GOLD', env)).toEqual({ limit: 7500, cap: 7500 });
  });

  it('defaults follow HARD_LOSS_EXIT_RUPEES / HARD_LOSS_CAP_RUPEES', () => {
    expect(lossLimitFor('NIFTY', { HARD_LOSS_EXIT_RUPEES: '2500', HARD_LOSS_CAP_RUPEES: '4000' })).toEqual({ limit: 2500, cap: 4000 });
    expect(lossLimitFor('NIFTY', { HARD_LOSS_EXIT_RUPEES: '2000', HARD_LOSS_CAP_RUPEES: '0' })).toEqual({ limit: 2000, cap: null });
  });

  it('master switch off (HARD_LOSS_EXIT_RUPEES unset) keeps the exit off even for GOLD; the GOLD cap still reads 7500', () => {
    expect(lossLimitFor('NIFTY', {})).toEqual({ limit: null, cap: 3000 });
    expect(lossLimitFor('GOLD', {})).toEqual({ limit: null, cap: 7500 });
  });
});

describe('hard loss exit per underlying (hard-floor.ts, 2026-11-04)', () => {
  const ENV = { HARD_LOSS_EXIT_RUPEES: '2000' };
  const SYM = 'GOLD27NOV26125000PE';

  it('hardLossTrip for a GOLD option at −₹7,600 net trips; at −₹2,500 does not', () => {
    const { limit } = lossLimitFor(SYM, ENV);
    expect(hardLossTrip(-7600, limit)).toBe(true);
    expect(hardLossTrip(-2500, limit)).toBe(false);
  });

  it('hardLossConfig(env, lossLimitFor(symbol)): GOLD is the plain ₹7,500 rule (no noise band)', () => {
    const cfg = hardLossConfig(ENV, lossLimitFor(SYM, ENV));
    expect(cfg).toMatchObject({ limit: 7500, cap: 7500 });
    const base = { cfg, exposure: 'BEARISH' as const, underlying: 125500, entryUnderlying: 125000, bestUnderlying: 125000, nUnderlying: 10 };
    expect(hardLossReading({ ...base, netPnl: -7600 })).toMatchObject({ trip: true, band: 'PLAIN' });
    expect(hardLossReading({ ...base, netPnl: -2500 })).toMatchObject({ trip: false, band: null });
  });

  it('hardLossConfig(env) without a symbol and for NIFTY is unchanged', () => {
    expect(hardLossConfig(ENV)).toEqual({ limit: 2000, cap: 3000, noiseN: 3 });
    expect(hardLossConfig(ENV, lossLimitFor('NIFTY09NOV2623750PE', ENV))).toEqual({ limit: 2000, cap: 3000, noiseN: 3 });
    expect(hardLossConfig(ENV, lossLimitFor('GOLDM05DEC26FUT', ENV))).toEqual({ limit: 2000, cap: 3000, noiseN: 3 });
  });
});

describe('lossLimitForTrade: the hard rupee stop by trade value (owner 2026-11-09)', () => {
  const ENV = { HARD_LOSS_EXIT_RUPEES: '2000' };

  it('an index option is a hard 2k whatever its value', () => {
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, ENV)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitForTrade('BANKNIFTY25NOV2659000CE', 90_000, ENV)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitForTrade('SENSEX13NOV2678600CE', null, ENV)).toEqual({ limit: 2000, cap: 2000 });
  });
  it('a high-value stock trade is a hard 3k, from 25k of trade value', () => {
    expect(lossLimitForTrade('LAURUSLABS23NOV262360CE', 44_519, ENV)).toEqual({ limit: 3000, cap: 3000 });
    expect(lossLimitForTrade('DIVISLAB23NOV2611700CE', 25_000, ENV)).toEqual({ limit: 3000, cap: 3000 });
  });
  it('a smaller stock trade is a hard 2k', () => {
    expect(lossLimitForTrade('SBIN23NOV261020CE', 24_999, ENV)).toEqual({ limit: 2000, cap: 2000 });
  });
  it('the threshold and the high-value stop can be set', () => {
    const env = { ...ENV, HARD_LOSS_HIGH_VALUE_TRADE_RUPEES: '40000', HARD_LOSS_HIGH_VALUE_EXIT_RUPEES: '3500' };
    expect(lossLimitForTrade('X23NOV26100CE', 39_999, env)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitForTrade('X23NOV26100CE', 40_000, env)).toEqual({ limit: 3500, cap: 3500 });
  });
  it('a stock named like an index is not an index', () => {
    expect(lossLimitForTrade('NIFTYBEES', 50_000, ENV)).toEqual({ limit: 3000, cap: 3000 });
  });
  it('a listed underlying keeps its own figure', () => {
    expect(lossLimitForTrade('GOLD27NOV26125000PE', 90_000, ENV)).toEqual({ limit: 7500, cap: 7500 });
  });
  it('an unknown value on a stock falls back to the old rule, and off is the rollback', () => {
    expect(lossLimitForTrade('SBIN23NOV261020CE', null, ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitForTrade('SBIN23NOV261020CE', Number.NaN, ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, { ...ENV, HARD_LOSS_BY_TRADE_VALUE: 'off' })).toEqual({ limit: 2000, cap: 3000 });
  });
  it('with the master switch off nothing exits', () => {
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, {}).limit).toBeNull();
    expect(lossLimitForTrade('LAURUSLABS23NOV262360CE', 44_519, {}).limit).toBeNull();
  });
});
