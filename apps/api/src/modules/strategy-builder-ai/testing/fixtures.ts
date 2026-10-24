import type { BuilderStateInput } from '../domain/definition';
import type { RiskLimitsView } from '../domain/checks';

/** A visual-mode strategy that passes every deterministic check. */
export function goodVisual(over: Partial<BuilderStateInput> = {}): BuilderStateInput {
  return {
    mode: 'visual',
    name: 'RSI dip buy',
    description: 'Buy NIFTY calls on oversold RSI in an uptrend',
    timeframe: '15m',
    segment: 'OPTIONS',
    instrument: 'NIFTY',
    indicators: [{ name: 'RSI', params: { period: 14 } }],
    entryRules: [{ logic: 'AND', conditions: [{ leftOperand: 'RSI(close, 14)', operator: 'less_than', rightOperand: '30' }] }],
    exitRules: [{ logic: 'AND', conditions: [{ leftOperand: 'RSI(close, 14)', operator: 'greater_than', rightOperand: '60' }] }],
    settings: {
      stopLossKind: 'ATR',
      stopLossValue: 1.5,
      targetKind: 'ATR',
      targetValue: 3,
      riskPerTradeRupees: 1000,
      capitalPerTradeRupees: 5000,
      maxOpenPositions: 2,
      maxTradesPerDay: 3,
      sessionStart: '09:30',
      sessionEnd: '15:00',
      fillAt: 'next_open',
    },
    ...over,
  };
}

export const LIMITS: RiskLimitsView = {
  maxRiskPerTrade: 2000,
  maxOpenPositions: 3,
  maxTradesPerDay: 5,
  optionsMaxPremiumPerTrade: 10000,
  maxCapitalDeployed: 50000,
};
