import type { EntryPlan } from './gate';
import type { SignalTradingMode } from './signal-trader.config';

/** Ops-bot texts (contract §X rule 4). Pure; never carries credentials or ids beyond our own. */
const tag = (mode: SignalTradingMode) => (mode === 'live' ? '[LIVE]' : '[SHADOW]');

export function takeAlert(i: {
  mode: SignalTradingMode;
  channel: string;
  plan: EntryPlan;
  agreeCount: number;
  conflict: boolean;
  confidence: number;
  reasons: string[];
}): string {
  const p = i.plan;
  return [
    `${tag(i.mode)} Signal TAKE ${p.side} ${p.tradingsymbol} (${i.channel})`,
    `qty ${p.qty} (${p.lots} lot${p.lots === 1 ? '' : 's'}) LIMIT ${p.limitPrice} (LTP ${p.ltp})`,
    `SL ${p.sl} (${p.engineSl ? `ENGINE SL: ${p.engineSl.method}` : p.slSource}) | targets ${p.targets.length ? p.targets.join(' / ') : 'none'}`,
    `risk ₹${p.riskRupees} | agree ${i.agreeCount}${i.conflict ? ' CONFLICT' : ''} | conf ${i.confidence}`,
    ...i.reasons.slice(0, 3).map((r) => `• ${r}`),
    i.mode === 'live' ? 'Order being placed.' : 'Shadow: no order placed.',
  ].join('\n');
}

export function skipAlert(i: { mode: SignalTradingMode; channel: string; what: string; reason: string; detail?: string }): string {
  return `${tag(i.mode)} Signal SKIP ${i.what} (${i.channel}): ${i.reason}${i.detail ? ` — ${i.detail}` : ''}`;
}

export function fillAlert(i: { symbol: string; side: string; qty: number; price: number; sl: number; slArmed: string }): string {
  return `[LIVE] Signal FILLED ${i.side} ${i.symbol} x${i.qty} @ ${i.price} | SL ${i.sl}: ${i.slArmed}`;
}

export function rejectAlert(i: { symbol: string; status: string; reason: string }): string {
  return `[LIVE] Signal order ${i.status} ${i.symbol}: ${i.reason}`;
}

export function updateAlert(i: { symbol: string; kind: string; text: string }): string {
  return `Signal update ${i.symbol}: ${i.kind} — ${i.text.slice(0, 300)} (passed to the sentinel; no automatic exit)`;
}

/** A "BUY ABOVE / SELL BELOW" signal passed everything except the price: now waiting for it. */
export function triggerArmedAlert(i: { mode: SignalTradingMode; channel: string; what: string; symbol: string; op: string; price: number; ltp: number | null; expiresAt: string; slSource: string }): string {
  const until = new Date(i.expiresAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${tag(i.mode)} Signal WAITING ${i.what} (${i.channel}): ${i.symbol} LTP ${i.ltp ?? '?'} — entry when ${i.op} ${i.price}, until ${until} IST (SL ${i.slSource}). Gate re-runs at the trigger.`;
}

/** The trigger price was reached: the full gate (and, if stale, the judge) runs again now. */
export function triggerFiredAlert(i: { mode: SignalTradingMode; symbol: string; op: string; price: number; ltp: number }): string {
  return `${tag(i.mode)} Signal TRIGGER hit ${i.symbol}: LTP ${i.ltp} ${i.op} ${i.price} — re-running the gate before any order.`;
}
