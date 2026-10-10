import { Prisma } from '@prisma/client';
import {
  compareLimit,
  fromStorage,
  hhmmToMinutes,
  isLimitKey,
  isLimitPair,
  LIMIT_KEY_NAMES,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  pairId,
  parseLimitValue,
  toStorage,
  wireValue,
} from './limit-keys';

const D = (s: string) => new Prisma.Decimal(s);

describe('limit vocabulary (spec §5.2)', () => {
  it('declares every key with its tighter direction', () => {
    expect(Object.fromEntries(LIMIT_KEY_NAMES.map((k) => [k, LIMIT_KEYS[k].tighter]))).toEqual({
      maxDailyLoss: 'lower',
      maxDailyLossPerStrategy: 'lower',
      maxTradesPerDay: 'lower',
      maxOpenPositions: 'lower',
      maxRiskPerTrade: 'lower',
      maxCapitalDeployed: 'lower',
      mtfMaxLeverage: 'lower',
      mtfMaxHoldDays: 'lower',
      optionsMaxPremiumPerTrade: 'lower',
      lastEntryTime: 'earlier',
      squareOffTime: 'earlier',
      dailyLossAction: 'stricter',
    });
  });

  it('has 21 (key, scope) pairs: totals, and per vehicle where the spec says so', () => {
    expect(LIMIT_PAIRS.map(pairId)).toEqual([
      'maxDailyLoss@ALL', 'maxDailyLossPerStrategy@ALL', 'maxTradesPerDay@ALL',
      'maxOpenPositions@ALL', 'maxOpenPositions@CASH_INTRADAY', 'maxOpenPositions@MTF', 'maxOpenPositions@OPTIONS_BUY',
      'maxRiskPerTrade@ALL',
      'maxCapitalDeployed@CASH_INTRADAY', 'maxCapitalDeployed@MTF', 'maxCapitalDeployed@OPTIONS_BUY',
      'mtfMaxLeverage@MTF', 'mtfMaxHoldDays@MTF', 'optionsMaxPremiumPerTrade@OPTIONS_BUY',
      'lastEntryTime@CASH_INTRADAY', 'lastEntryTime@MTF', 'lastEntryTime@OPTIONS_BUY',
      'squareOffTime@CASH_INTRADAY', 'squareOffTime@MTF', 'squareOffTime@OPTIONS_BUY',
      'dailyLossAction@ALL',
    ]);
  });

  it('knows which keys and scopes exist, and refuses prototype names', () => {
    expect(isLimitKey('maxDailyLoss')).toBe(true);
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'MAXDAILYLOSS', '']) {
      expect(isLimitKey(bad)).toBe(false);
    }
    expect(isLimitPair('maxOpenPositions', 'MTF')).toBe(true);
    expect(isLimitPair('maxDailyLoss', 'MTF')).toBe(false);
    expect(isLimitPair('mtfMaxLeverage', 'ALL')).toBe(false);
    expect(isLimitPair('nope', 'ALL')).toBe(false);
  });
});

describe('parseLimitValue', () => {
  it('rupees: a JSON number with at most 2 dp, 0 or more, below 10^12, kept as a 2-dp string', () => {
    expect(parseLimitValue('maxDailyLoss', 5000)).toEqual({ ok: true, value: '5000.00' });
    expect(parseLimitValue('maxDailyLoss', 0)).toEqual({ ok: true, value: '0.00' });
    expect(parseLimitValue('maxRiskPerTrade', 1234.5)).toEqual({ ok: true, value: '1234.50' });
    for (const bad of ['5000', NaN, Infinity, -1, 1.234, 1e12, null, undefined, true]) {
      expect(parseLimitValue('maxDailyLoss', bad).ok).toBe(false);
    }
  });

  it('count: a whole number, 0 or more', () => {
    expect(parseLimitValue('maxTradesPerDay', 20)).toEqual({ ok: true, value: '20' });
    expect(parseLimitValue('maxOpenPositions', 0)).toEqual({ ok: true, value: '0' });
    for (const bad of [1.5, -1, '3', NaN, 1e12]) expect(parseLimitValue('mtfMaxHoldDays', bad).ok).toBe(false);
  });

  it('ratio: 1 or more with at most 2 dp', () => {
    expect(parseLimitValue('mtfMaxLeverage', 2)).toEqual({ ok: true, value: '2.00' });
    expect(parseLimitValue('mtfMaxLeverage', 1)).toEqual({ ok: true, value: '1.00' });
    for (const bad of [0.5, 0, -2, 2.555, '2']) expect(parseLimitValue('mtfMaxLeverage', bad).ok).toBe(false);
  });

  it('hhmm: a 24-hour IST time', () => {
    expect(parseLimitValue('lastEntryTime', '15:00')).toEqual({ ok: true, value: '15:00' });
    expect(parseLimitValue('squareOffTime', '09:05')).toEqual({ ok: true, value: '09:05' });
    for (const bad of ['9:05', '24:00', '15:60', '1500', 1500, '']) expect(parseLimitValue('lastEntryTime', bad).ok).toBe(false);
  });

  it('enum: one of the daily-loss actions', () => {
    expect(parseLimitValue('dailyLossAction', 'BLOCK_AND_SQUARE_OFF')).toEqual({ ok: true, value: 'BLOCK_AND_SQUARE_OFF' });
    for (const bad of ['block_entries', 'SQUARE_OFF', 1, null]) expect(parseLimitValue('dailyLossAction', bad).ok).toBe(false);
  });
});

describe('storage', () => {
  it('numeric kinds go to numValue, times and the action to textValue, and back unchanged', () => {
    expect(toStorage('maxDailyLoss', '5000.00')).toEqual({ numValue: D('5000.00'), textValue: null });
    expect(toStorage('lastEntryTime', '15:00')).toEqual({ numValue: null, textValue: '15:00' });
    expect(fromStorage('maxDailyLoss', D('5000'), null)).toBe('5000.00');
    expect(fromStorage('maxOpenPositions', D('5.00'), null)).toBe('5');
    expect(fromStorage('mtfMaxLeverage', D('2'), null)).toBe('2.00');
    expect(fromStorage('lastEntryTime', null, '15:00')).toBe('15:00');
    expect(fromStorage('dailyLossAction', null, 'BLOCK_ENTRIES')).toBe('BLOCK_ENTRIES');
  });

  it('a stored row that does not fit its key reads as null (the wall then fails closed)', () => {
    expect(fromStorage('maxDailyLoss', null, '5000')).toBeNull();
    expect(fromStorage('maxDailyLoss', null, null)).toBeNull();
    expect(fromStorage('maxOpenPositions', D('2.5'), null)).toBeNull();
    expect(fromStorage('lastEntryTime', D('900'), null)).toBeNull();
    expect(fromStorage('lastEntryTime', null, '9am')).toBeNull();
    expect(fromStorage('dailyLossAction', null, 'PANIC')).toBeNull();
  });

  it('the wire carries numbers for numeric kinds and strings otherwise', () => {
    expect(wireValue('maxDailyLoss', '5000.00')).toBe(5000);
    expect(wireValue('maxOpenPositions', '5')).toBe(5);
    expect(wireValue('squareOffTime', '15:15')).toBe('15:15');
    expect(wireValue('dailyLossAction', 'BLOCK_ENTRIES')).toBe('BLOCK_ENTRIES');
  });
});

describe('compareLimit (D5 direction)', () => {
  it('lower is tighter for money, counts and leverage', () => {
    expect(compareLimit('maxDailyLoss', '5000.00', '4000.00')).toBe('TIGHTER');
    expect(compareLimit('maxDailyLoss', '5000.00', '5000.00')).toBe('SAME');
    expect(compareLimit('maxDailyLoss', '5000.00', '5000.01')).toBe('LOOSER');
    expect(compareLimit('maxOpenPositions', '5', '10')).toBe('LOOSER');
    expect(compareLimit('mtfMaxLeverage', '2.00', '1.50')).toBe('TIGHTER');
  });

  it('earlier is tighter for times', () => {
    expect(compareLimit('lastEntryTime', '15:00', '14:30')).toBe('TIGHTER');
    expect(compareLimit('squareOffTime', '15:15', '15:20')).toBe('LOOSER');
    expect(compareLimit('squareOffTime', '15:15', '15:15')).toBe('SAME');
  });

  it('BLOCK_AND_SQUARE_OFF is tighter than BLOCK_ENTRIES', () => {
    expect(compareLimit('dailyLossAction', 'BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')).toBe('TIGHTER');
    expect(compareLimit('dailyLossAction', 'BLOCK_AND_SQUARE_OFF', 'BLOCK_ENTRIES')).toBe('LOOSER');
    expect(compareLimit('dailyLossAction', 'BLOCK_ENTRIES', 'BLOCK_ENTRIES')).toBe('SAME');
  });

  it('hhmmToMinutes counts minutes since IST midnight', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('15:15')).toBe(915);
  });
});
