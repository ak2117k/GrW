import type { LimitKey, LimitScope } from '../limits/limit-keys';
import type { CoreEntryIntent, LimitInForce, RiskContext, RiskLiveState, RiskOpenPosition } from '../risk-wall.types';

/**
 * Test data only. These numbers are fixtures, not defaults: the seed defaults are
 * rows in the M2 migration (core-risk-defaults.spec.ts checks them).
 */
const VALUES: ReadonlyArray<readonly [LimitKey, LimitScope, string]> = [
  ['maxDailyLoss', 'ALL', '5000.00'],
  ['maxDailyLossPerStrategy', 'ALL', '2500.00'],
  ['maxTradesPerDay', 'ALL', '20'],
  ['maxOpenPositions', 'ALL', '5'],
  ['maxOpenPositions', 'CASH_INTRADAY', '5'],
  ['maxOpenPositions', 'MTF', '3'],
  ['maxOpenPositions', 'OPTIONS_BUY', '2'],
  ['maxRiskPerTrade', 'ALL', '3000.00'],
  ['maxCapitalDeployed', 'CASH_INTRADAY', '1000000.00'],
  ['maxCapitalDeployed', 'MTF', '200000.00'],
  ['maxCapitalDeployed', 'OPTIONS_BUY', '100000.00'],
  ['mtfMaxLeverage', 'MTF', '2.00'],
  ['mtfMaxHoldDays', 'MTF', '10'],
  ['optionsMaxPremiumPerTrade', 'OPTIONS_BUY', '50000.00'],
  ['lastEntryTime', 'CASH_INTRADAY', '15:00'],
  ['lastEntryTime', 'MTF', '15:00'],
  ['lastEntryTime', 'OPTIONS_BUY', '14:30'],
  ['squareOffTime', 'CASH_INTRADAY', '15:15'],
  ['squareOffTime', 'MTF', '15:20'],
  ['squareOffTime', 'OPTIONS_BUY', '15:15'],
  ['dailyLossAction', 'ALL', 'BLOCK_ENTRIES'],
];

/** Mon 2026-10-12 10:30 IST, inside the NSE/NFO session. */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

/** Every pair, with overrides by "key@scope"; null removes the pair. */
export function limitsFixture(over: Record<string, string | null> = {}): LimitInForce[] {
  return VALUES.flatMap(([key, scope, value]) => {
    const id = `${key}@${scope}`;
    const v = Object.prototype.hasOwnProperty.call(over, id) ? over[id] : value;
    return v === null
      ? []
      : [{ key, scope, value: v, rowId: `lim_${id}`, effectiveFrom: '2026-10-09T03:45:00.000Z', source: 'USER' as const }];
  });
}

/** Cash intraday BUY 50 RELIANCE @ 2500, stop 2462.5 (risk 37.5/unit), 5x intraday margin (500/unit). */
export function intentFixture(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return {
    kind: 'ENTRY',
    intentId: 'int_1',
    userId: 'user_A',
    strategyId: 'cs_ungated',
    strategyVersionId: 'csv_ungated_v1',
    vehicle: 'CASH_INTRADAY',
    exchange: 'NSE',
    symbol: 'RELIANCE',
    underlying: 'RELIANCE',
    side: 'BUY',
    optionType: null,
    qty: 50,
    lotSize: 1,
    refPrice: 2500,
    refPriceFresh: true,
    stopPrice: 2462.5,
    capitalPerUnit: 500,
    mtfLeverage: null,
    ...over,
  };
}

/** One lot (75) of a NIFTY CE @ 120 premium, premium stop 90. */
export function optionIntent(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return intentFixture({
    vehicle: 'OPTIONS_BUY',
    exchange: 'NFO',
    symbol: 'NIFTY26OCT25000CE',
    underlying: 'NIFTY',
    optionType: 'CE',
    qty: 75,
    lotSize: 75,
    refPrice: 120,
    stopPrice: 90,
    capitalPerUnit: 120,
    ...over,
  });
}

/** MTF BUY 10 TCS @ 4000, stop 3880, 2x leverage (2000/unit own funds). */
export function mtfIntent(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return intentFixture({
    vehicle: 'MTF',
    symbol: 'TCS',
    underlying: 'TCS',
    qty: 10,
    refPrice: 4000,
    stopPrice: 3880,
    capitalPerUnit: 2000,
    mtfLeverage: 2,
    ...over,
  });
}

export function positionFixture(over: Partial<RiskOpenPosition> = {}): RiskOpenPosition {
  return {
    positionId: 'pos_1',
    strategyId: 'cs_adaptive_stop',
    vehicle: 'CASH_INTRADAY',
    symbol: 'INFY',
    underlying: 'INFY',
    direction: 'LONG',
    state: 'OPEN',
    priced: true,
    ...over,
  };
}

export function stateFixture(over: Partial<RiskLiveState> = {}): RiskLiveState {
  return {
    asOf: NOW,
    openPositions: [],
    realisedPnlToday: 0,
    openPnl: 0,
    pnlTodayByStrategy: {},
    tradesToday: 0,
    deployedCapital: { CASH_INTRADAY: 0, MTF: 0, OPTIONS_BUY: 0 },
    dailyLossLatched: false,
    ...over,
  };
}

export function ctxFixture(over: Partial<RiskContext> = {}): RiskContext {
  return { now: NOW, limits: limitsFixture(), killSwitchActive: false, sessionOpen: true, state: stateFixture(), ...over };
}
