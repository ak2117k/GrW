import { useQuery } from '@tanstack/react-query';
import { getNightReport } from '@/services/nightReport';

/** The night report. Read on open and on demand (refresh); overnight data does not move by the second. */
export function useNightReport() {
  return useQuery({
    queryKey: ['night-report'],
    queryFn: getNightReport,
    staleTime: 60_000,
  });
}
