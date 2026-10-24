import type { EntryPlan, GateCheck } from './gate';
import type { SignalView } from './signal.types';

/**
 * Funds check before a LIVE signal entry (owner request 2026-10-23: "if there is a lack of funds in
 * the account, create a paper trade of that so that we can analyze it later"). Pure.
 *
 * Required funds:
 *  - option BUY / cash equity: limit × qty plus a small buffer for charges (full premium / notional —
 *    no intraday leverage is assumed, so a cash entry is never under-estimated);
 *  - futures (either side) and option SELL: the broker's own margin calculator (SmartAPI `marginApi`
 *    over the owner's live session, no second login) plus the buffer — `method: 'broker'`; when that
 *    call fails, a CONSERVATIVE ESTIMATE — SIGNAL_FUT_MARGIN_PCT (default 25 %) of the notional
 *    (futures: limit × qty; option writing: strike × qty) plus the buffer — `method: 'estimate'`.
 * A broker rejection for funds/margin is handled separately ({@link isFundsRejection}), so an
 * estimate that is too low still ends in the same paper fallback.
 */
export interface FundsRequirement {
  required: number;
  method: 'premium' | 'notional' | 'estimate' | 'broker';
  detail: string;
}

export interface FundsRecord {
  /** ₹ available (RMS availablecash) or null = could not be read ('unknown'). */
  available: number | null;
  required: number;
  /** true enough, false short, null unknown (not evaluated → the live order goes ahead as before). */
  ok: boolean | null;
  method: FundsRequirement['method'];
}

export type FundsCheck = GateCheck & { funds: FundsRecord };

const r2 = (n: number) => Math.round(n * 100) / 100;
export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function requiredFunds(
  plan: Pick<EntryPlan, 'side' | 'limitPrice' | 'qty'>,
  signal: Pick<SignalView, 'instrumentKind' | 'strike'>,
  cfg: { fundsBufferPct: number; futMarginPct: number },
  /** Futures / option writing: the broker margin-calculator answer (null = not asked). */
  broker: BrokerMargin | null = null,
): FundsRequirement {
  const buffer = 1 + cfg.fundsBufferPct / 100;
  const kind = signal.instrumentKind;
  const option = kind === 'CE' || kind === 'PE';
  if (option && plan.side === 'BUY') {
    const v = plan.limitPrice * plan.qty * buffer;
    return { required: r2(v), method: 'premium', detail: `premium ${plan.limitPrice} × ${plan.qty} + ${cfg.fundsBufferPct}% charges` };
  }
  if (kind === 'EQ') {
    const v = plan.limitPrice * plan.qty * buffer;
    return { required: r2(v), method: 'notional', detail: `notional ${plan.limitPrice} × ${plan.qty} + ${cfg.fundsBufferPct}% charges (no leverage assumed)` };
  }
  if (broker && broker.ok) {
    return { required: r2(broker.margin * buffer), method: 'broker', detail: `broker margin calculator ${inr(broker.margin)} + ${cfg.fundsBufferPct}% charges` };
  }
  const base = option ? (signal.strike ?? plan.limitPrice) : plan.limitPrice;
  const notional = base * plan.qty;
  const v = (notional * cfg.futMarginPct) / 100 * buffer;
  const why = broker && !broker.ok ? `broker margin unavailable: ${broker.reason}` : 'no broker margin API wired';
  return {
    required: r2(v),
    method: 'estimate',
    detail: `ESTIMATE (${why}): ${cfg.futMarginPct}% of ${option ? 'strike' : 'price'} notional ${inr(notional)} + ${cfg.fundsBufferPct}% charges`,
  };
}

/** Does this entry need MARGIN (futures, option writing) rather than full premium / notional? */
export function needsMargin(side: 'BUY' | 'SELL', kind: SignalView['instrumentKind']): boolean {
  if (kind === 'FUT') return true;
  return (kind === 'CE' || kind === 'PE') && side === 'SELL';
}

/** The broker margin-calculator answer: a positive ₹ figure, or why it could not be used. */
export type BrokerMargin = { ok: true; margin: number } | { ok: false; reason: string };

/**
 * One position for SmartAPI `marginApi` (POST /margin/v1/batch). Quantity in the same unit the order
 * is sent in (units for NFO/BFO; MCX per AI_AUTO_EXIT_QTY_UNITS).
 */
export function marginPosition(
  plan: Pick<EntryPlan, 'exchange' | 'token' | 'side' | 'limitPrice' | 'qty' | 'lots'>,
  product: string,
  qtyUnit: 'units' | 'lots' | null,
): Record<string, unknown> {
  return {
    exchange: plan.exchange,
    qty: qtyUnit === 'lots' ? plan.lots : plan.qty,
    price: plan.limitPrice,
    productType: product,
    token: plan.token,
    tradeType: plan.side,
    orderType: 'LIMIT',
  };
}

/**
 * The SDK RESOLVES every outcome (never rejects): `{status:true, data:{totalMarginRequired}}` on
 * success, `{status:false, message, errorcode}` / `{}` / a bare status on failure. Only a positive,
 * finite totalMarginRequired is a usable answer; everything else names why it is not.
 */
export function parseMarginResponse(resp: unknown): BrokerMargin {
  if (!resp || typeof resp !== 'object') return { ok: false, reason: 'empty response' };
  const o = resp as Record<string, unknown>;
  if (o.status === false) return { ok: false, reason: `broker: ${String(o.message ?? o.errorcode ?? 'status false').slice(0, 120)}` };
  const data = o.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'no data in the response' };
  const raw = data.totalMarginRequired;
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? ''));
  if (!Number.isFinite(n) || !(n > 0)) return { ok: false, reason: `totalMarginRequired ${JSON.stringify(raw ?? null)}` };
  return { ok: true, margin: r2(n) };
}

/** The `funds` gate check, with the raw numbers kept on it for the page and the analysis. */
export function fundsCheck(available: number | null, req: FundsRequirement): FundsCheck {
  if (available === null || !Number.isFinite(available)) {
    return {
      name: 'funds',
      ok: null,
      required: false,
      detail: `funds unknown (broker RMS unreadable) — need ${inr(req.required)} (${req.detail}); order sent as before`,
      funds: { available: null, required: req.required, ok: null, method: req.method },
    };
  }
  const ok = available >= req.required;
  return {
    name: 'funds',
    ok,
    required: true,
    detail: `${ok ? 'enough' : 'INSUFFICIENT'}: available ${inr(available)} vs need ${inr(req.required)} (${req.detail})`,
    funds: { available: r2(available), required: req.required, ok, method: req.method },
  };
}

/**
 * Does a broker / RMS rejection text mean "not enough funds or margin"? Angel RMS phrases seen:
 * "Insufficient Funds", "RMS:Margin Exceeds,Required:…, Available:…", "margin shortfall",
 * "Insufficient margin". Deliberately narrow: any other rejection stays a plain rejection.
 */
export function isFundsRejection(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  return /insufficient\s*(funds?|margin|balance)|margin\s*(exceed|shortfall|insufficient|not\s*(available|sufficient))|rms\s*:?\s*margin|fund\s*limit\s*(insufficient|exceed)|not\s*enough\s*(funds?|margin)/i.test(t);
}
