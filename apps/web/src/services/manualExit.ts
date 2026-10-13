import { createVisibilityAwarePoller, type VisibilityDoc } from '@/services/interval-poller';
import type { AiExitRow } from '@/hooks/useAiExits';
import type { TradeTracker } from '@/hooks/useTradeTrackers';

/**
 * Owner "Exit now" on a Trade Tracker row (POST /api/sentinel-executor/exit/:trackerId).
 * It places a REAL order through the guarded sentinel-executor pipeline. The
 * API answers at once with the attempt's row (usually CLAIMED); the page then
 * polls GET /sentinel-executor/executions every {@link MANUAL_EXIT_POLL_MS}
 * until the row is terminal.
 */
export const MANUAL_EXIT_EXCHANGES: readonly string[] = ['NFO', 'BFO', 'MCX'];
export const MANUAL_EXIT_POLL_MS = 3_000;
/** Stop polling after this long; a row still PLACED then is a resting order the owner checks at the broker. */
export const MANUAL_EXIT_POLL_MAX_MS = 120_000;

/**
 * Show the Exit button: ADMIN (the owner) only, OPEN F&O POSITION rows only, and
 * never at qty 0 — the closing side would be unknown (the server sizes from the
 * broker and may BUY to close a short), so the confirm text could not be truthful.
 */
export function canExitTracker(t: Pick<TradeTracker, 'status' | 'kind' | 'exchange' | 'qty'>, role: string | null | undefined): boolean {
  return (
    role === 'ADMIN' &&
    t.status === 'OPEN' &&
    t.kind === 'POSITION' &&
    Number(t.qty) !== 0 && Number.isFinite(Number(t.qty)) &&
    MANUAL_EXIT_EXCHANGES.includes(String(t.exchange ?? '').toUpperCase())
  );
}

/** Closing side from the tracker's signed qty: a long is sold, a short is bought back. */
export function exitSide(qty: number): 'Sell' | 'Buy' {
  return qty < 0 ? 'Buy' : 'Sell';
}

/** "Sell 100 CRUDEOIL15OCT268950CE at MARKET?" */
export function exitConfirmText(t: Pick<TradeTracker, 'qty' | 'symbol'>): string {
  return `${exitSide(t.qty)} ${Math.abs(t.qty)} ${t.symbol} at MARKET?`;
}

/** CLAIMED / PLACED are still working; everything else is final. */
export function isTerminalExitStatus(status: AiExitRow['status'] | string | null | undefined): boolean {
  return status !== 'CLAIMED' && status !== 'PLACED';
}

/** One-line inline status for the row: "FILLED · order O1", "SKIPPED: OPEN_ORDER_EXISTS". */
export function exitStatusLine(r: Pick<AiExitRow, 'status' | 'reason' | 'brokerOrderId' | 'brokerMessage'>): string {
  const head = r.status === 'CLAIMED' ? 'SENDING' : r.status;
  const parts = [r.reason ? `${head}: ${r.reason}` : head];
  if (r.brokerOrderId) parts.push(`order ${r.brokerOrderId}`);
  if ((r.status === 'REJECTED' || r.status === 'FAILED') && r.brokerMessage) parts.push(r.brokerMessage);
  return parts.join(' · ');
}

export type ExitTone = 'working' | 'good' | 'bad' | 'muted';
export function exitTone(status: AiExitRow['status']): ExitTone {
  if (status === 'FILLED') return 'good';
  if (status === 'CLAIMED' || status === 'PLACED') return 'working';
  if (status === 'REJECTED' || status === 'FAILED') return 'bad';
  return 'muted';
}

/** A human message from a failed POST (403 / 404 / 422 carry the API's reason). */
export function exitErrorText(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: unknown } } } | undefined;
  const msg = e?.response?.data?.message;
  const text = Array.isArray(msg) ? msg.join('; ') : typeof msg === 'string' ? msg : '';
  const status = e?.response?.status;
  if (text) return text;
  if (status === 403) return 'Manual exit is not enabled for this account';
  if (status === 404) return 'Tracker not found';
  return 'Exit request failed — check the broker before retrying';
}

/**
 * Poll the executions list for one attempt until it is terminal (or
 * `maxMs` passes). Delivers each sighting of the row; never overlaps; nothing
 * after `stop()`. A failed poll is ignored (the next tick retries).
 */
export function startExitStatusPolling(opts: {
  executionId: string;
  get: () => Promise<AiExitRow[]>;
  onRow: (row: AiExitRow) => void;
  onDone?: () => void;
  now?: () => number;
  doc?: VisibilityDoc | null;
  intervalMs?: number;
  maxMs?: number;
}): { stop: () => void } {
  const now = opts.now ?? (() => Date.now());
  const until = now() + (opts.maxMs ?? MANUAL_EXIT_POLL_MAX_MS);
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    poller.stop();
    opts.onDone?.();
  };
  const poller = createVisibilityAwarePoller({
    intervalMs: opts.intervalMs ?? MANUAL_EXIT_POLL_MS,
    doc: opts.doc,
    shouldPoll: () => !stopped,
    task: async () => {
      if (now() > until) return finish();
      try {
        const rows = await opts.get();
        if (stopped) return;
        const row = Array.isArray(rows) ? rows.find((r) => r.id === opts.executionId) : undefined;
        if (row) {
          opts.onRow(row);
          if (isTerminalExitStatus(row.status)) finish();
        }
      } catch {
        // transient — the next tick retries
      }
    },
  });
  return {
    stop: () => {
      stopped = true;
      poller.stop();
    },
  };
}
