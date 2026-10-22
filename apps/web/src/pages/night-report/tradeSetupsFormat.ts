import type { TradeSetupView, TradeSetupsView } from '@/types/nightReport.types';

const inr = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');

/** "LONG" → buy, "SHORT" → sell. */
export function sideText(s: TradeSetupView): string {
  return s.side === 'SHORT' ? 'SELL / short' : 'BUY / long';
}

/** "2 lots (500 units)" for futures, "35 shares" for cash. */
export function qtyText(s: TradeSetupView): string {
  if (s.lots != null) return `${s.lots} lot${s.lots === 1 ? '' : 's'} (${s.qty} units, lot ${s.lotSize ?? '?'})`;
  return `${s.qty} share${s.qty === 1 ? '' : 's'}`;
}

/** "Risk ₹2,000 (1%) · T1 ₹3,000 · T2 ₹5,000 · margin ₹10,000". */
export function riskText(s: TradeSetupView): string {
  return `Risk ${inr(s.riskRs)} (${s.riskPct}%) · T1 +${inr(s.rewardT1Rs)} · T2 +${inr(s.rewardT2Rs)} · margin ${s.instrumentKind === 'FUTURES' ? '~' : ''}${inr(s.marginUsed)}`;
}

/** "Entry ref 1400.00 · stop 1372.00 (28.00) · T1 1442.00 · T2 1470.00". */
export function levelsText(s: TradeSetupView): string {
  return `Entry ref ${num(s.entryRef)} · stop ${num(s.stop)} (${num(s.stopDistance)}) · T1 ${num(s.target1)} · T2 ${num(s.target2)} · ATR ${num(s.atr)}`;
}

export function sessionLine(v: TradeSetupsView): string {
  if (!v.sessionDate) return 'No next NSE session found.';
  return `For the ${v.sessionDate} session · ${v.setups.length} setup${v.setups.length === 1 ? '' : 's'} (news idea + big-move model agree)`;
}

export function outcomeText(s: TradeSetupView): string | null {
  if (!s.outcome) return null;
  const r = s.outcome.r != null ? ` (${s.outcome.r >= 0 ? '+' : ''}${s.outcome.r}R)` : '';
  return `Outcome: ${s.outcome.status.replace('_', ' ').toLowerCase()}${r}`;
}
