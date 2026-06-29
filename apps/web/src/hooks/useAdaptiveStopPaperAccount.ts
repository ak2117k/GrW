import { useEffect, useState } from 'react';
import { getAdaptiveStopAccount } from '../services/adaptiveStopWatch';
import type { AdaptiveStopPaperAccount } from '../types/adaptiveStopWatch.types';

export function useAdaptiveStopPaperAccount() {
  const [account, setAccount] = useState<AdaptiveStopPaperAccount | null>(null);
  useEffect(() => {
    getAdaptiveStopAccount().then(setAccount).catch(() => setAccount(null));
  }, []);
  return { account };
}
