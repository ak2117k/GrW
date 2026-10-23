import type { EntryPlan, GateCheck } from './gate';
import type { SignalView } from './signal.types';

/**
 * Funds check before a LIVE signal entry (owner request 2026-10-23: "if there is a lack of funds in
 * the account, create a paper trade of that so that we can analyze it later"). Pure.
 *
 * Required funds:
 *  - option BUY / cash equity: limit × qty plus a small buffer for charges (full premium / notional —
 *    no intraday leverage is assumed, so a cash entry is never under-estimated);
 *  - futures (either side) and option SELL: the codebase has no broker margin-calculator call wired
 *    (the SmartAPI SDK exposes `marginApi`, unused here), so a CONSERVATIVE ESTIMATE is used —
 *    SIGNAL_FUT_MARGIN_PCT (default 25 %) of the notional (futures: limit × qty; option writing:
 *    strike × qty) plus the same buffer. The gate record says so (`method: 'estimate'`).
 * A broker rejection for funds/margin is handled separately ({@link isFundsRejection}), so an
 * estimate that is too low still ends in the same paper fallback.
 */
export interface FundsRequirement {
  required: number;
  method: 'premium' | 'notional' | 'estimate';
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
  const base = option ? (signal.strike ?? plan.limitPrice) : plan.limitPrice;
  const notional = base * plan.qty;
  const v = (notional * cfg.futMarginPct) / 100 * buffer;
  return {
    required: r2(v),
    method: 'estimate',
    detail: `ESTIMATE (no broker margin API wired): ${cfg.futMarginPct}% of ${option ? 'strike' : 'price'} notional ${inr(notional)} + ${cfg.fundsBufferPct}% charges`,
  };
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
