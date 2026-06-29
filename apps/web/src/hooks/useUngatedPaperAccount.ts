import { useEffect, useState } from 'react';
import { getUngatedAccount } from '../services/ungatedWatch';
import type { UngatedPaperAccount } from '../types/ungatedWatch.types';

export function useUngatedPaperAccount() {
  const [account, setAccount] = useState<UngatedPaperAccount | null>(null);
  useEffect(() => {
    getUngatedAccount().then(setAccount).catch(() => setAccount(null));
  }, []);
  return { account };
}
