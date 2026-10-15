import type { SentinelTriggerRow } from '@/hooks/useSentinelTriggers';
import { istTime } from './aiExitView';

const sign = (op: SentinelTriggerRow['op']) => (op === 'ABOVE' ? '>' : '<');

export function armedForTracker(rows: SentinelTriggerRow[], trackerId: string): SentinelTriggerRow | null {
  return rows.find((r) => r.trackerId === trackerId && r.status === 'ARMED') ?? null;
}

/** "auto-exit if CRUDEOIL19NOV26FUT < 8930, armed 22:33 IST" — null unless ARMED. */
export function armedTriggerLine(r: SentinelTriggerRow): string | null {
  if (r.status !== 'ARMED' || r.price == null || !r.op) return null;
  const at = r.armedAt ? `, armed ${istTime(r.armedAt)}` : '';
  return `auto-exit if ${r.watchSymbol ?? r.symbol} ${sign(r.op)} ${r.price}${at}`;
}

export function triggerHistoryLine(r: SentinelTriggerRow): string {
  const level = r.price != null && r.op ? ` — ${sign(r.op)} ${r.price} on ${r.watchSymbol ?? r.symbol}` : '';
  if (r.status === 'FIRED') {
    const when = r.firedAt ? ` (${istTime(r.firedAt)})` : '';
    return `FIRED at ${r.firedPrice ?? '?'}${when}${level}`;
  }
  return `${r.status}${r.reason ? `: ${r.reason}` : ''}${level}`;
}
