/**
 * Owner alerts (2026-10-29): a message to the owner for a LIVE position the
 * executor cannot act on — cash equity is observe-only, so an AI EXIT_NOW or a
 * square-off decision on it only matters if a human reads it in time.
 *
 * A PORT, so the cycle's import graph never reaches the sender (or anything near
 * order code): the module binds it to the Telegram ops-alert adapter
 * (adapters/owner-alert.telegram.adapter.ts). The paper instance is built without
 * one, so paper positions never alert. The cycle calls `send` fire-and-forget: a
 * throw or a rejection is logged and never fails the judgement.
 */
export const OWNER_ALERTS = 'SENTINEL_OWNER_ALERTS';

export interface OwnerAlert {
  /** square-off-decision: the deadline look's verdict; observe-only-exit: an EXIT_NOW nothing will carry out. */
  kind: 'square-off-decision' | 'observe-only-exit';
  /** Stable per message the cycle means to send (the adapter's de-duplication key). */
  key: string;
  userId: string;
  trackerId: string;
  symbol: string;
  exchange: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  ltp: number;
  /** Net of charges, from the packet's money block. */
  netPnl: number;
  verdict: string;
  confidence: string;
  /** The verdict's reason, cut to one line by the cycle. */
  reason: string;
  /** Minutes to the deadline (MIS square-off for intraday cash), or null when the session is not open. */
  minutesToSquareOff: number | null;
  /** HH:MM IST of the deadline, when known. */
  deadlineIst: string | null;
}

export interface OwnerAlertPort {
  send(alert: OwnerAlert): Promise<void> | void;
}

const inr = (n: number) => `${n < 0 ? '−' : '+'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** The message text. Pure: the adapter only transports it. */
export function formatOwnerAlert(a: OwnerAlert): string {
  const head =
    a.kind === 'square-off-decision'
      ? `GrW sentinel — ${a.symbol} (${a.exchange}): square-off decision`
      : `GrW sentinel — ${a.symbol} (${a.exchange}): AI says EXIT_NOW`;
  const clock =
    a.minutesToSquareOff === null
      ? 'Session not open.'
      : a.minutesToSquareOff > 0
        ? `${Math.round(a.minutesToSquareOff)} min to the broker square-off${a.deadlineIst ? ` (${a.deadlineIst} IST)` : ''}.`
        : `Past the broker square-off${a.deadlineIst ? ` (${a.deadlineIst} IST)` : ''}.`;
  return [
    head,
    `${a.side} ${Math.abs(a.qty)} @ ${a.entryPrice} · LTP ${a.ltp} · P&L ${inr(a.netPnl)} (net)`,
    `AI: ${a.verdict} (${a.confidence}) — ${a.reason}`,
    clock,
    'Observe-only: nothing automatic will exit this cash position — act manually if you agree.',
  ].join('\n');
}
