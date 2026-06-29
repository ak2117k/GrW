import { useEffect, useState } from 'react';
import api from '../services/api';

export interface PaperAccount {
  startingCapital: number;
  balance: number;
  deployedCapital: number;
  unrealizedPnl: number;
  /** Profit from winning exits, held until the 18:00 IST settlement. */
  pendingProfit: number;
  equity: number;
  openPositions: number;
  /** ISO timestamp — trades before this are ignored (legacy journal data). */
  epoch: string;
}

export function usePaperAccount(pollMs = 5000) {
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const res = await api.get<PaperAccount>('/trades/paper-account');
        if (alive) {
          setAccount(res.data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  return { account, error };
}
