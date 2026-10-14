import { useEffect, useState } from 'react';
import api from '@/services/api';
import { createVisibilityAwarePoller, type VisibilityDoc } from '@/services/interval-poller';

/** Wire shape of GET /api/sentinel-executor/executions (api: AiExitExecutionDto). */
export interface AiExitRow {
  id: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  productType: string | null;
  orderType: 'MARKET' | 'LIMIT' | null;
  limitPrice: number | null;
  mode: 'dry-run' | 'live';
  status: 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED';
  reason: string | null;
  sessionSource: 'user-feed' | 'ephemeral' | null;
  brokerOrderId: string | null;
  brokerMessage: string | null;
  orderStatus: string | null;
  marketOrderId: string | null;
  verdictReason: string;
  /** AI = sentinel verdict; MANUAL = the owner's Exit button. Optional: older APIs omit it. */
  trigger?: 'AI' | 'MANUAL';
  createdAt: string;
  updatedAt: string;
}

/** One indexed, user-scoped SELECT of ≤ 20 rows — cheap enough at 10 s while the tab is visible. */
export const AI_EXITS_POLL_MS = 10_000;

/**
 * 403 = this account is not allowed to see AI exits (not admin / not
 * allow-listed); 404 = the endpoint is not deployed. Both are permanent for
 * this page view, so the list stays empty and polling stops.
 */
export function isQuietDenial(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  return status === 403 || status === 404;
}

/**
 * Loads once immediately, then every `intervalMs` while the tab is visible.
 * A quiet denial (403/404) delivers `[]` and stops for good; any other failure
 * keeps the last rows and the next tick retries. Nothing is delivered after
 * `stop()`.
 */
export function startAiExitPolling(opts: {
  get: () => Promise<unknown>;
  onData: (rows: AiExitRow[]) => void;
  doc?: VisibilityDoc | null;
  intervalMs?: number;
}): { stop: () => void } {
  let stopped = false;
  let denied = false;
  let busy = false;

  const load = async (): Promise<void> => {
    if (stopped || denied || busy) return;
    busy = true;
    try {
      const data = await opts.get();
      if (!stopped) opts.onData(Array.isArray(data) ? (data as AiExitRow[]) : []);
    } catch (err) {
      if (isQuietDenial(err)) {
        denied = true;
        poller.stop();
        if (!stopped) opts.onData([]);
      }
      // Otherwise transient (cold API, network) — keep the last rows.
    } finally {
      busy = false;
    }
  };

  const poller = createVisibilityAwarePoller({
    intervalMs: opts.intervalMs ?? AI_EXITS_POLL_MS,
    doc: opts.doc,
    shouldPoll: () => !denied,
    task: load,
  });
  void load();

  return {
    stop: () => {
      stopped = true;
      poller.stop();
    },
  };
}

/**
 * What the sentinel auto-exit did. FAILS QUIET like useSentinelPositions: a
 * 403 (not the owner), 404 (not deployed) or a cold API leaves the list empty
 * and the page looks exactly as before.
 */
export function useAiExits(): { rows: AiExitRow[] } {
  const [rows, setRows] = useState<AiExitRow[]>([]);
  useEffect(() => {
    const p = startAiExitPolling({
      get: async () => {
        const { data } = await api.get<AiExitRow[]>('/sentinel-executor/executions', { params: { limit: 20 } });
        return data;
      },
      onData: setRows,
    });
    return () => p.stop();
  }, []);
  return { rows };
}
