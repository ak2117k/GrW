import { useEffect, useState } from 'react';
import { getSellFuturesAccount } from '../services/sellFuturesWatch';
import type { SellFuturesPaperAccount } from '../types/sellFuturesWatch.types';

export function useSellFuturesPaperAccount() {
  const [account, setAccount] = useState<SellFuturesPaperAccount | null>(null);
  useEffect(() => {
    getSellFuturesAccount().then(setAccount).catch(() => setAccount(null));
  }, []);
  return { account };
}
