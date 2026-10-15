import { useEffect, useState } from 'react';
import api from '@/services/api';
import { startQuietPolling } from './useAiExits';

/** Wire shape of GET /api/sentinel-executor/triggers (api: SentinelExitTriggerDto). */
export interface SentinelTriggerRow {
  id: string;
  trackerId: string;
  verdictId: string;
  symbol: string;
  instrument: 'UNDERLYING' | 'PREMIUM' | null;
  op: 'BELOW' | 'ABOVE' | null;
  price: number | null;
  watchSymbol: string | null;
  refPrice: number | null;
  status: 'ARMED' | 'FIRED' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED';
  reason: string | null;
  armedAt: string | null;
  endedAt: string | null;
  firedAt: string | null;
  firedPrice: number | null;
  firedTickAt: string | null;
  createdAt: string;
}

/** An armed level changes at most once per verdict; 15 s while visible is plenty. */
export const TRIGGERS_POLL_MS = 15_000;

/** Fails quiet (403/404/cold API): no rows, the panel looks exactly as before. */
export function useSentinelTriggers(): { rows: SentinelTriggerRow[] } {
  const [rows, setRows] = useState<SentinelTriggerRow[]>([]);
  useEffect(() => {
    const p = startQuietPolling<SentinelTriggerRow>({
      get: async () => (await api.get<SentinelTriggerRow[]>('/sentinel-executor/triggers', { params: { limit: 20 } })).data,
      onData: setRows,
      intervalMs: TRIGGERS_POLL_MS,
    });
    return () => p.stop();
  }, []);
  return { rows };
}
