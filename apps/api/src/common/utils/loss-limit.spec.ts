import {
  ceilingTableOn, chartAbsLossRupees, hardLossNoiseUnit, instrumentClass, lossLimitBeforeCeilings, lossLimitFor, lossLimitForTrade, parseCeilingByClass,
  parseLossLimitsByUnderlying, usesN15Band,
} from './loss-limit';
import { hardLossBandOn, hardLossConfig, hardLossReading, hardLossTrip } from '../../modules/exit-discipline/hard-floor';
import { riskCapFor } from '../../modules/signal-trader/domain/gate';

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

describe('per-class catastrophe ceilings (HARD_LOSS_CEILING_BY_CLASS, owner 2026-11-25)', () => {
  const ENV = { HARD_LOSS_EXIT_RUPEES: '2000' };
  const TABLE = 'INDEX_OPT:5000,STOCK_OPT:5000,GOLD:7500,SILVER:7500,MCX:5000';
  const ON = { ...ENV, HARD_LOSS_CEILING_BY_CLASS: TABLE };

  it('instrumentClass: index / stock options by exchange, GOLD / SILVER (incl. the minis) / other MCX, else OTHER', () => {
    expect(instrumentClass('NIFTY09NOV2623750PE', 'NFO')).toBe('INDEX_OPT');
    expect(instrumentClass('BANKNIFTY25NOV2659000CE', 'NFO')).toBe('INDEX_OPT');
    expect(instrumentClass('NIFTYNXT5025NOV2670000CE', 'NFO')).toBe('INDEX_OPT');
    expect(instrumentClass('SENSEX13NOV2678600CE', 'BFO')).toBe('INDEX_OPT');
    expect(instrumentClass('SBIN23NOV261020CE', 'NFO')).toBe('STOCK_OPT');
    expect(instrumentClass('NIFTYBEES', 'NSE')).toBe('OTHER');
    expect(instrumentClass('GOLD27NOV26125000PE', 'MCX')).toBe('GOLD');
    expect(instrumentClass('GOLDM05DEC26FUT', 'MCX')).toBe('GOLD');
    expect(instrumentClass('SILVER05DEC26FUT', 'MCX')).toBe('SILVER');
    expect(instrumentClass('SILVERM27FEB26FUT', 'mcx')).toBe('SILVER');
    expect(instrumentClass('GOLDGUINEA28NOV26FUT', 'MCX')).toBe('MCX');
    expect(instrumentClass('CRUDEOILM17NOV269350PE', 'MCX')).toBe('MCX');
    expect(instrumentClass('NATURALGAS25NOV26300CE', 'MCX')).toBe('MCX');
    expect(instrumentClass('SBIN-EQ', 'NSE')).toBe('OTHER');
    expect(instrumentClass('', 'NFO')).toBe('OTHER');
  });

  it('instrumentClass without an exchange: MCX names and index names are still known, anything else is OTHER', () => {
    expect(instrumentClass('GOLD27NOV26125000PE', null)).toBe('GOLD');
    expect(instrumentClass('NIFTY09NOV2623750PE', '')).toBe('INDEX_OPT');
    expect(instrumentClass('SBIN23NOV261020CE', undefined)).toBe('OTHER');
    expect(instrumentClass('GOLDBEES', null)).toBe('OTHER');
  });

  it('parse: unset / blank / off = no table; junk entries ignored, valid kept; unknown classes and OTHER are junk', () => {
    expect(parseCeilingByClass(undefined)).toEqual({});
    expect(parseCeilingByClass('  ')).toEqual({});
    expect(parseCeilingByClass('OFF')).toEqual({});
    expect(parseCeilingByClass(TABLE)).toEqual({ INDEX_OPT: 5000, STOCK_OPT: 5000, GOLD: 7500, SILVER: 7500, MCX: 5000 });
    expect(parseCeilingByClass('index_opt:5000, GOLD:abc,MCX:-1,OTHER:9000,FOO:5000,SILVER:0,STOCK_OPT:5000:1,:5000')).toEqual({ INDEX_OPT: 5000 });
    expect(ceilingTableOn({ HARD_LOSS_CEILING_BY_CLASS: 'GOLD:x,FOO:1' })).toBe(false);
    expect(ceilingTableOn(ON)).toBe(true);
  });

  it("table unset → today's limit / cap, exactly", () => {
    expect(lossLimitFor('NIFTY09NOV2623750PE', 'NFO', ENV)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitFor('GOLD27NOV26125000PE', 'MCX', ENV)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, 'NFO', ENV)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitForTrade('LAURUSLABS23NOV262360CE', 44_519, 'NFO', ENV)).toEqual({ limit: 3000, cap: 3000 });
    expect(lossLimitForTrade('GOLD27NOV26125000PE', 90_000, 'MCX', ENV)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, 'NFO', { ...ENV, HARD_LOSS_CEILING_BY_CLASS: 'off' })).toEqual({ limit: 2000, cap: 2000 });
  });

  it('INDEX_OPT NIFTY…CE → {limit 2000, cap 5000} with the noise band on', () => {
    expect(lossLimitFor('NIFTY25NOV2623750CE', 'NFO', ON)).toEqual({ limit: 2000, cap: 5000 });
    const lim = lossLimitForTrade('NIFTY25NOV2623750CE', 13_000, 'NFO', ON);
    expect(lim).toEqual({ limit: 2000, cap: 5000 });
    const cfg = hardLossConfig(ON, lim);
    expect(cfg).toEqual({ limit: 2000, cap: 5000, noiseN: 3 });
    expect(hardLossBandOn(cfg)).toBe(true);
  });

  it("GOLD option → {2000, 7500} with the band on (not today's plain 7500); SILVER / STOCK_OPT / other MCX get their ceilings", () => {
    const gold = lossLimitForTrade('GOLD27NOV26125000PE', 90_000, 'MCX', ON);
    expect(gold).toEqual({ limit: 2000, cap: 7500 });
    expect(hardLossBandOn(hardLossConfig(ON, gold))).toBe(true);
    expect(lossLimitForTrade('SILVERM27FEB26100000CE', 20_000, 'MCX', ON)).toEqual({ limit: 2000, cap: 7500 });
    expect(lossLimitForTrade('LAURUSLABS23NOV262360CE', 44_519, 'NFO', ON)).toEqual({ limit: 2000, cap: 5000 });
    expect(lossLimitForTrade('CRUDEOILM17NOV269350PE', 7_000, 'MCX', ON)).toEqual({ limit: 2000, cap: 5000 });
  });

  it("a class missing from the table keeps today's figures; OTHER always does", () => {
    const only = { ...ENV, HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:5000' };
    expect(lossLimitForTrade('GOLD27NOV26125000PE', 90_000, 'MCX', only)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitForTrade('SBIN23NOV261020CE', 24_999, 'NFO', only)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitFor('SBIN-EQ', 'NSE', ON)).toEqual({ limit: 2000, cap: 3000 });
  });

  it("junk table → today's figures (never \"no cap\")", () => {
    const junk = { ...ENV, HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:abc,GOLD:-5,FOO:5000,MCX:' };
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, 'NFO', junk)).toEqual({ limit: 2000, cap: 2000 });
    expect(lossLimitForTrade('GOLD27NOV26125000PE', 90_000, 'MCX', junk)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitFor('NIFTY09NOV2625100PE', 'NFO', junk)).toEqual({ limit: 2000, cap: 3000 });
  });

  it('the master switch stays HARD_LOSS_EXIT_RUPEES: unset ⇒ limit null for every class', () => {
    expect(lossLimitForTrade('NIFTY09NOV2625100PE', 13_000, 'NFO', { HARD_LOSS_CEILING_BY_CLASS: TABLE }).limit).toBeNull();
  });

  it('loss −5,000 on INDEX_OPT → CAP, whatever the underlying did', () => {
    const cfg = hardLossConfig(ON, lossLimitForTrade('NIFTY25NOV2623750CE', 13_000, 'NFO', ON));
    const base = { cfg, exposure: 'BULLISH' as const, underlying: 23800, entryUnderlying: 23800, bestUnderlying: 23800, nUnderlying: 40 };
    expect(hardLossReading({ ...base, netPnl: -5000 })).toMatchObject({ trip: true, band: 'CAP', cap: 5000 });
    expect(hardLossReading({ ...base, netPnl: -4999 })).toMatchObject({ trip: false, band: 'HOLD_UNDER_N' });
  });

  it("the band's noise unit, per position: N15 for a listed class (null stays null — never N1), N1 with the table off", () => {
    const NIFTY = ['NIFTY25NOV2623750CE', 'NFO'] as const;
    expect(hardLossNoiseUnit(ENV, ...NIFTY, 10.73, 31.5)).toBe(10.73);
    expect(hardLossNoiseUnit(ON, ...NIFTY, 10.73, 31.5)).toBe(31.5);
    expect(hardLossNoiseUnit(ON, ...NIFTY, 10.73, null)).toBeNull();
    expect(hardLossNoiseUnit(ON, ...NIFTY, 10.73, undefined)).toBeNull();
  });

  it('a class NOT in the table (partial table, OTHER) keeps N1 exactly as today', () => {
    const partial = { ...ENV, HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:5000' };
    expect(usesN15Band('SBIN23NOV261020CE', 'NFO', partial)).toBe(false);
    expect(hardLossNoiseUnit(partial, 'SBIN23NOV261020CE', 'NFO', 10.73, 31.5)).toBe(10.73);
    expect(hardLossNoiseUnit(partial, 'GOLD27NOV26125000PE', 'MCX', 10.73, null)).toBe(10.73);
    expect(hardLossNoiseUnit(ON, 'SBIN-EQ', 'NSE', 10.73, 31.5)).toBe(10.73);
    expect(usesN15Band('NIFTY25NOV2623750CE', 'NFO', partial)).toBe(true);
  });

  it("lossLimitBeforeCeilings is table-blind: today's figures with the table on", () => {
    expect(lossLimitBeforeCeilings('GOLD27NOV26125000PE', ON)).toEqual({ limit: 7500, cap: 7500 });
    expect(lossLimitBeforeCeilings('NIFTY25NOV2623750CE', ON)).toEqual({ limit: 2000, cap: 3000 });
    expect(lossLimitBeforeCeilings('NIFTY25NOV2623750CE', ON)).toEqual(lossLimitFor('NIFTY25NOV2623750CE', ENV));
  });

  it('entry gate riskCapFor is unchanged with the table on', () => {
    for (const env of [ENV, ON]) {
      expect(riskCapFor('NIFTY', 'NIFTY25NOV2623750CE', 2000, env)).toBe(2000);
      expect(riskCapFor('GOLD', 'GOLD27NOV26125000PE', 2000, env)).toBe(7500);
      expect(riskCapFor('SBIN', 'SBIN23NOV261020CE', 2000, env)).toBe(2000);
      expect(riskCapFor('CRUDEOIL', 'CRUDEOILM17NOV269350PE', 2000, env)).toBe(2000);
    }
  });

  it('chart hold ceiling: HARD_LOSS_ABS_RUPEES with the table off; the class ceiling with it on', () => {
    expect(chartAbsLossRupees('NIFTY25NOV2623750CE', 'NFO', { ...ENV, HARD_LOSS_ABS_RUPEES: '3500' })).toBe(3500);
    expect(chartAbsLossRupees('NIFTY25NOV2623750CE', 'NFO', ENV)).toBe(3500);
    expect(chartAbsLossRupees('NIFTY25NOV2623750CE', 'NFO', { ...ON, HARD_LOSS_ABS_RUPEES: '3500' })).toBe(5000);
    expect(chartAbsLossRupees('GOLD27NOV26125000PE', 'MCX', { ...ON, HARD_LOSS_ABS_RUPEES: '3500' })).toBe(7500);
    expect(chartAbsLossRupees('SBIN-EQ', 'NSE', { ...ON, HARD_LOSS_ABS_RUPEES: '3500' })).toBe(3500);
  });
});
