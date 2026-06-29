import { useEffect, useState } from 'react';
import { getAdaptiveStopComparison } from '../services/adaptiveStopComparison';
import type { DailyComparison } from '../types/adaptiveStopWatch.types';

export function useAdaptiveStopComparison(date: string) {
  const [data, setData] = useState<DailyComparison | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAdaptiveStopComparison(date).then((r) => { if (!cancelled) setData(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [date]);
  return { data };
}
