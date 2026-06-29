import { useEffect, useState } from 'react';
import { getDailyComparison } from '../services/ungatedComparison';
import type { DailyComparison } from '../types/ungatedWatch.types';

export function useDailyComparison(date: string) {
  const [data, setData] = useState<DailyComparison | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDailyComparison(date).then((r) => { if (!cancelled) setData(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [date]);
  return { data };
}
