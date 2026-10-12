import { Prisma } from '@prisma/client';
import type { HubExchange, Price, PriceDepth } from '../../../market-hub/hub.types';
import type { CoreOrderRequest } from '../execution.types';
import { resolvePaperSettings, type PaperDefaultValue, type PaperSettings } from '../paper-settings';

const D = (s: string) => new Prisma.Decimal(s);

/** Monday 2026-10-12, 10:30 IST. */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

/** The Task 5 migration's seed rows, as values (core-paper-defaults.spec.ts checks they match). */
export const SEED_ROWS: PaperDefaultValue[] = [
  { key: 'startingCapital', scope: 'ALL', numValue: D('1000000.00') },
  { key: 'intradayLeverage', scope: 'CASH_INTRADAY', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'CASH_INTRADAY', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'MTF', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'OPTIONS_BUY', numValue: D('50.00') },
  { key: 'noPriceRejectMs', scope: 'ALL', numValue: D('30000') },
  { key: 'mtfFundedShare', scope: 'MTF', numValue: D('0.50') },
  { key: 'mtfAnnualRatePct', scope: 'MTF', numValue: D('18.00') },
  { key: 'mtfPledgeFee', scope: 'MTF', numValue: D('23.60') },
  { key: 'maxLotsPerOrder', scope: 'NIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'BANKNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'FINNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'MIDCPNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'SENSEX', numValue: D('10') },
];

export function paperSettings(over: Partial<PaperSettings> = {}): PaperSettings {
  const r = resolvePaperSettings(SEED_ROWS);
  if (!r.ok) throw new Error(`fixture settings incomplete: ${r.missing.join(', ')}`);
  return { ...r.settings, ...over };
}

export function cashBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return {
    userId: 'user_A',
    idempotencyKey: 'intent_cash_1:entry',
    vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY',
    qty: 100,
    type: 'MARKET',
    limitPrice: null,
    triggerPrice: null,
    refPrice: 500,
    purpose: 'ENTRY',
    strategyVersionId: 'ver_1',
    ...over,
  };
}

export function mtfBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return cashBuy({
    idempotencyKey: 'intent_mtf_1:entry',
    vehicle: 'MTF',
    instrument: { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null },
    qty: 10,
    refPrice: 1000,
    ...over,
  });
}

export function optionBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return cashBuy({
    idempotencyKey: 'intent_opt_1:entry',
    vehicle: 'OPTIONS_BUY',
    instrument: { exchange: 'NFO', token: '43521', symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY' },
    qty: 150,
    type: 'LIMIT',
    limitPrice: 100,
    refPrice: 100,
    ...over,
  });
}

export function depth(asks: Array<[number, number]>, bids: Array<[number, number]> = []): PriceDepth {
  return {
    asks: asks.map(([price, qty]) => ({ price, qty, orders: 1 })),
    bids: bids.map(([price, qty]) => ({ price, qty, orders: 1 })),
  };
}

export function hubPrice(req: Pick<CoreOrderRequest, 'instrument'>, ltp: number, at: number, book?: PriceDepth): Price {
  return {
    ref: { exchange: req.instrument.exchange as HubExchange, token: req.instrument.token, symbol: req.instrument.symbol },
    ltp,
    at,
    source: 'ws',
    ...(book ? { depth: book } : {}),
  };
}
