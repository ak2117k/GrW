import { useQuery } from '@tanstack/react-query';
import { getLessons, getProposals, getSelfReviewRuns } from '@/services/selfReview';

export const SELF_REVIEW_KEYS = {
  proposals: ['self-review', 'proposals'] as const,
  pendingCount: ['self-review', 'proposals', 'pending-count'] as const,
  lessons: ['self-review', 'lessons'] as const,
  runs: ['self-review', 'runs'] as const,
};

/** Nav badge poll: proposals are created once a night, so every five minutes is plenty. */
export const PENDING_POLL_MS = 5 * 60_000;

/** Every proposal (all statuses); the page splits pending from decided. */
export function useProposals() {
  return useQuery({ queryKey: SELF_REVIEW_KEYS.proposals, queryFn: () => getProposals(), staleTime: 30_000 });
}

export function useLessons() {
  return useQuery({ queryKey: SELF_REVIEW_KEYS.lessons, queryFn: getLessons, staleTime: 60_000 });
}

export function useSelfReviewRuns(limit = 30) {
  return useQuery({ queryKey: [...SELF_REVIEW_KEYS.runs, limit], queryFn: () => getSelfReviewRuns(limit), staleTime: 60_000 });
}

/**
 * Pending-proposal count for the nav badge. Owner-only (the endpoint is admin),
 * silent on error (no badge rather than a broken nav), no retries.
 */
export function usePendingProposalCount(enabled: boolean) {
  return useQuery({
    queryKey: SELF_REVIEW_KEYS.pendingCount,
    queryFn: async () => (await getProposals('PENDING')).filter((p) => p.status === 'PENDING').length,
    enabled,
    refetchInterval: enabled ? PENDING_POLL_MS : false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
}
