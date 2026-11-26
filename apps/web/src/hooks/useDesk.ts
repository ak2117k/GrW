import { useQuery } from '@tanstack/react-query';
import { getDeskDecisions, getDeskState } from '@/services/deskManager';

/** Poll every 20 s, only while the tab is visible (react-query pauses intervals in background tabs). */
const POLL_MS = 20_000;

export function useDeskState() {
  return useQuery({ queryKey: ['desk-state'], queryFn: getDeskState, refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}

export function useDeskDecisions(date?: string) {
  return useQuery({ queryKey: ['desk-decisions', date ?? 'today'], queryFn: () => getDeskDecisions(date), refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}
