import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import type { AiExitRow } from '@/hooks/useAiExits';
import type { TradeTracker } from '@/hooks/useTradeTrackers';
import { exitErrorText, isTerminalExitStatus, startExitStatusPolling } from '@/services/manualExit';

export interface ManualExitState {
  /** A request or a working attempt (CLAIMED/PLACED) — the button stays disabled. */
  busy: boolean;
  row: AiExitRow | null;
  error: string | null;
}

/**
 * The owner's "Exit now" per tracker: POST (the API returns the attempt's row
 * at once), then poll the executions list every 3 s until the row is terminal.
 * A repeat click on a still-working attempt is answered by the API with that
 * same attempt, so it only resumes the polling.
 */
export function useManualExit(): {
  states: Record<string, ManualExitState>;
  exit: (t: TradeTracker) => Promise<void>;
} {
  const [states, setStates] = useState<Record<string, ManualExitState>>({});
  const busyRef = useRef(new Set<string>());
  const pollers = useRef(new Map<string, { stop: () => void }>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const live = pollers.current;
    return () => {
      mounted.current = false;
      for (const p of live.values()) p.stop();
      live.clear();
    };
  }, []);

  const put = useCallback((id: string, s: ManualExitState) => {
    if (mounted.current) setStates((prev) => ({ ...prev, [id]: s }));
  }, []);

  const exit = useCallback(
    async (t: TradeTracker) => {
      if (busyRef.current.has(t.id)) return;
      busyRef.current.add(t.id);
      put(t.id, { busy: true, row: null, error: null });
      const release = () => {
        busyRef.current.delete(t.id);
        pollers.current.delete(t.id);
      };
      try {
        const { data: row } = await api.post<AiExitRow>(`/sentinel-executor/exit/${encodeURIComponent(t.id)}`);
        if (isTerminalExitStatus(row.status)) {
          release();
          put(t.id, { busy: false, row, error: null });
          return;
        }
        put(t.id, { busy: true, row, error: null });
        pollers.current.get(t.id)?.stop();
        let last: AiExitRow = row;
        pollers.current.set(
          t.id,
          startExitStatusPolling({
            executionId: row.id,
            get: async () => {
              const { data } = await api.get<AiExitRow[]>('/sentinel-executor/executions', { params: { limit: 50 } });
              return data;
            },
            onRow: (r) => {
              last = r;
              put(t.id, { busy: !isTerminalExitStatus(r.status), row: r, error: null });
            },
            onDone: () => {
              release();
              put(t.id, { busy: false, row: last, error: null });
            },
          }),
        );
      } catch (err) {
        release();
        put(t.id, { busy: false, row: null, error: exitErrorText(err) });
      }
    },
    [put],
  );

  return { states, exit };
}
