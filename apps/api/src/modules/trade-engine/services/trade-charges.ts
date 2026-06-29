/**
 * Indian equity-intraday charges for a single paper order. Pure module — one
 * source of truth for R6. No DP charges (delivery only), no delivery STT.
 * Exchanges other than NSE use the BSE transaction rate.
 */

const BROKERAGE_RATE = 0.0003;       // 0.03% of turnover
const BROKERAGE_CAP = 20;            // INR 20 per order
const STT_SELL_RATE = 0.00025;       // 0.025% on the sell leg
const EXCHANGE_TXN_NSE = 0.0000297;  // 0.00297%
const EXCHANGE_TXN_BSE = 0.0000375;  // 0.00375%
const SEBI_RATE = 0.000001;          // INR 10 per crore
const STAMP_DUTY_BUY_RATE = 0.00003; // 0.003% on the buy leg
const GST_RATE = 0.18;               // 18% on (brokerage + exchange txn)

export interface OrderChargeInput {
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  exchange: string;
}

export interface OrderCharges {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeOrderCharges(input: OrderChargeInput): OrderCharges {
  const turnover = Math.max(0, input.price) * Math.max(0, input.quantity);
  const isBuy = input.side === 'BUY';
  const isNse = (input.exchange ?? 'NSE').toUpperCase() === 'NSE';

  const brokerage = Math.min(turnover * BROKERAGE_RATE, BROKERAGE_CAP);
  const stt = isBuy ? 0 : turnover * STT_SELL_RATE;
  const exchangeTxn = turnover * (isNse ? EXCHANGE_TXN_NSE : EXCHANGE_TXN_BSE);
  const sebiFee = turnover * SEBI_RATE;
  const stampDuty = isBuy ? turnover * STAMP_DUTY_BUY_RATE : 0;
  const gst = (brokerage + exchangeTxn) * GST_RATE;

  const brokerageR = round2(brokerage);
  const sttR = round2(stt);
  const exchangeTxnR = round2(exchangeTxn);
  const sebiFeeR = round2(sebiFee);
  const stampDutyR = round2(stampDuty);
  const gstR = round2(gst);

  return {
    brokerage: brokerageR,
    stt: sttR,
    exchangeTxn: exchangeTxnR,
    sebiFee: sebiFeeR,
    stampDuty: stampDutyR,
    gst: gstR,
    // total is the sum of the rounded fields, so total === sum(fields) exactly.
    total: round2(brokerageR + sttR + exchangeTxnR + sebiFeeR + stampDutyR + gstR),
  };
}
