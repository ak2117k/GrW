import type { CoreJournalRowView, CoreJournalStatusView } from '@/services/coreJournal';

/** Pure logic for the Core Journal page (spec §8.4). The server decides; these only word and format. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function rupees(s: string | null): string {
  if (s === null) return '—';
  return `₹${Number(s).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pnlTone(s: string | null): 'ok' | 'danger' | 'muted' {
  const n = s === null ? 0 : Number(s);
  return n > 0 ? 'ok' : n < 0 ? 'danger' : 'muted';
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function eventLine(r: CoreJournalRowView): { time: string; title: string; detail: string } {
  const p = r.payload;
  const time = istTime(r.createdAt);
  switch (r.type) {
    case 'ALERT_RECEIVED':
      return { time, title: `Alert: ${str(p.scanName) || 'Chartink'}`, detail: `score ${str(p.score)} at ₹${str(p.alertPrice)}` };
    case 'INTENT_SKIPPED':
      return { time, title: `Skipped: ${str(p.reason)}`, detail: str(p.detail) };
    case 'RISK_VERDICT': {
      const reasons = Array.isArray(p.reasons) ? (p.reasons as Array<{ code?: unknown }>).map((x) => str(x.code)).join(', ') : '';
      return { time, title: `Risk Wall: ${str(p.verdict)} ${str(p.qty)}`, detail: reasons };
    }
    case 'ORDER_PLACED':
      return { time, title: `${str(p.purpose)} order: ${str(p.side)} ${str(p.qty)}`, detail: str(p.orderId) };
    case 'ORDER_STATE':
      return { time, title: `Order ${str(p.state)}`, detail: `${str(p.filledQty)} filled${p.rejectReason ? ` — ${str(p.rejectReason)}` : ''}` };
    case 'FILL':
      return { time, title: `Fill ${str(p.qty)} @ ${str(p.price)}`, detail: `charges ₹${str(p.charges)}` };
    case 'POSITION_STATE':
      return { time, title: `${str(p.from) || 'NEW'} → ${str(p.to)}`, detail: str(p.reason ?? p.exitReason) };
    case 'EXIT_DECIDED':
      return { time, title: `Exit: ${str(p.reason)}`, detail: str(p.detail) };
    case 'STOP_MOVED':
      return { time, title: `Stop ${str(p.from)} → ${str(p.to ?? p.proposed)}`, detail: str(p.why ?? p.source) };
    case 'BLIND':
      return { time, title: p.blind ? 'No fresh price (blind)' : 'Priced again', detail: p.noPriceForMs ? `${Math.round(Number(p.noPriceForMs) / 1000)} s without a price` : '' };
    case 'RECOVERY_STOP':
      return { time, title: 'Stop crossed while the server was down', detail: str(p.detail) };
    default:
      return { time, title: r.type, detail: '' };
  }
}

export function statusBanner(s: CoreJournalStatusView): { tone: 'ok' | 'warn' | 'danger'; lines: string[] } {
  const lines: string[] = [];
  let tone: 'ok' | 'warn' | 'danger' = 'ok';
  const worse = (t: 'warn' | 'danger') => {
    if (t === 'danger' || tone === 'ok') tone = t;
  };
  if (s.mismatches.length > 0) {
    worse('danger');
    lines.push(`${s.mismatches.length} reconciliation finding(s) block entries until acknowledged`);
  }
  if (s.journal.dropped > 0 || s.entries.dropped > 0) {
    worse('danger');
    lines.push(`dropped: ${s.journal.dropped} journal row(s), ${s.entries.dropped} Chartink hit(s)`);
  }
  if (s.journal.pending > 0) {
    worse('warn');
    lines.push(`${s.journal.pending} journal row(s) waiting to be written${s.journal.lastError ? ` (${s.journal.lastError})` : ''}`);
  }
  if (s.positions.blind > 0) {
    worse('warn');
    lines.push(`${s.positions.blind} open position(s) without a fresh price`);
  }
  if (s.entries.mode !== 'paper') {
    worse('warn');
    lines.push(s.entries.mode === 'journal' ? 'Entries are a dry run (journal only, no orders)' : 'Core entries are off');
  }
  if (lines.length === 0) lines.push(`Paper entries on; ${s.positions.active} active position(s)`);
  return { tone, lines };
}

const SKIP_LABELS: Record<string, string> = {
  MIN_SCORE: 'Score below the strategy minimum',
  COOLDOWN: 'Cooldown after the last entry',
  LAST_LOSS: "Today's last trade on it lost",
  HISTORY_UNKNOWN: 'Last trade not summarised yet',
  NO_PRICE_SOURCE: 'No price source for this user',
  NO_FRESH_PRICE: 'No fresh price in time',
  STALE_ENTRY: 'Price already ran past the alert',
  GATE: 'Decision gate said no',
  GATE_UNKNOWN: 'Unknown gate',
  PAPER_SETTINGS_MISSING: 'Paper settings missing',
  SIZE_ZERO: 'Sizing gives no unit',
  VEHICLE_UNSUPPORTED: 'Vehicle not supported yet',
  RISK_REJECT: 'Risk Wall rejected',
  OPEN_REFUSED: 'Position could not open',
  ENTRIES_DRY_RUN: 'Dry run (journal mode)',
  INTERNAL_ERROR: 'Internal error',
};

export function skipRows(skips: Record<string, number>): Array<{ reason: string; count: number; label: string }> {
  return Object.entries(skips)
    .map(([reason, count]) => ({ reason, count, label: SKIP_LABELS[reason] ?? reason }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function ackPayload(reason: string): Parsed<{ reason: string }> {
  const r = reason.trim();
  return r ? { ok: true, value: { reason: r } } : { ok: false, error: 'Say why you are acknowledging it' };
}

/** Only today's journal still changes; a past day is read once. */
export function pollsDay(day: string, todayIst: string): boolean {
  return day === todayIst;
}
