import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import type { Trade } from '@/types';

const POLL_MS = 30_000;

export const ltpKey = (exchange: string, token: string) => `${exchange.toUpperCase()}:${token}`;

/**
 * Live LTP for every instrument on the journal page — open AND closed rows, so "Current" shows
 * where the market is now, not the exit price. One batched POST /market-data/quotes (≤ 50 refs,
 * a page is 20); synthetic PAPER- tokens are not exchange tokens and are skipped.
 */
export function useJournalLtps(trades: Trade[]): Map<string, number> {
  const refs = useMemo(() => {
    const seen = new Map<string, { token: string; exchange: string }>();
    for (const t of trades) {
      if (!t.token || !t.exchange || t.token.startsWith('PAPER-')) continue;
      seen.set(ltpKey(t.exchange, t.token), { token: t.token, exchange: t.exchange });
    }
    return [...seen.values()].slice(0, 50);
  }, [trades]);

  const q = useQuery({
    queryKey: ['journal', 'ltps', refs.map((r) => ltpKey(r.exchange, r.token)).join(',')],
    enabled: refs.length > 0,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const res = await api.post('/market-data/quotes', { items: refs });
      const list: Array<{ token: string; exchange: string; ltp: number | null }> = res.data?.quotes ?? [];
      const out = new Map<string, number>();
      for (const r of list) if (r.ltp != null && r.ltp > 0) out.set(ltpKey(r.exchange, r.token), r.ltp);
      return out;
    },
  });
  return q.data ?? new Map();
}
