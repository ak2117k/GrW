import { useMarketStore } from '@/stores/market-store';
import { livePollMs } from '@/services/browser-feed';

/** The store-backed {@link livePollMs}: `false` while the hub feeds this browser and the feed is Live. */
export function useLivePollMs(baseMs: number): number | false {
  const source = useMarketStore((s) => s.feedSource);
  const health = useMarketStore((s) => s.feedHealth);
  return livePollMs(baseMs, { source, health });
}
