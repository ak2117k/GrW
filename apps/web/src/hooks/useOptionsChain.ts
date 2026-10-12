import { useEffect } from 'react';
import { useOptionsStore } from '@/stores/options-store';
import { chainPollMs } from '@/utils/chainAge';

/**
 * Fetches expiries when the underlying changes, then the chain, and keeps polling it: every 10 s while
 * the server says fresh/stale, every 60 s while it says market-closed (so an open page picks up the
 * session start). The server's status replaces the old client-side 09:15–15:30 guess.
 */
export function useOptionsChain() {
  const underlying = useOptionsStore((s) => s.underlying);
  const expiry = useOptionsStore((s) => s.expiry);
  const fetchExpiries = useOptionsStore((s) => s.fetchExpiries);
  const fetchChain = useOptionsStore((s) => s.fetchChain);

  useEffect(() => {
    fetchExpiries();
  }, [underlying, fetchExpiries]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await fetchChain();
      if (cancelled) return;
      timer = setTimeout(loop, chainPollMs(useOptionsStore.getState().chainMeta?.status));
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [underlying, expiry, fetchChain]);
}
