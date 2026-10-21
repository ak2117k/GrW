import { approveProposal, rejectProposal } from '@/services/selfReview';
import type { TuningProposal } from '@/types/selfReview.types';

export type Decision = 'approve' | 'reject';

/** The status a proposal shows the moment the owner decides (the server may move APPROVED → APPLIED). */
export function optimisticStatus(d: Decision): 'APPROVED' | 'REJECTED' {
  return d === 'approve' ? 'APPROVED' : 'REJECTED';
}

/** The list with one proposal's status replaced; the rest untouched. */
export function withStatus(list: TuningProposal[], id: string, status: string, decidedAt: string | null = null): TuningProposal[] {
  return list.map((p) => (p.id === id ? { ...p, status, decidedAt: decidedAt ?? p.decidedAt } : p));
}

export interface DecideHooks {
  /** Current list (read once, before the optimistic write). */
  get: () => TuningProposal[];
  set: (next: TuningProposal[]) => void;
  onSuccess?: (p: TuningProposal) => void;
  onError?: (err: unknown) => void;
  now?: () => string;
}

/**
 * Optimistically mark the proposal decided, call the API, then either keep the
 * server's row (when it returns one) or roll back to the previous list on error.
 * Returns true when the API accepted the decision.
 */
export async function decideProposal(id: string, decision: Decision, hooks: DecideHooks): Promise<boolean> {
  const before = hooks.get();
  const now = hooks.now?.() ?? new Date().toISOString();
  hooks.set(withStatus(before, id, optimisticStatus(decision), now));
  try {
    const res = decision === 'approve' ? await approveProposal(id) : await rejectProposal(id);
    const server = res && typeof res === 'object' && 'id' in res ? (res as TuningProposal) : null;
    if (server) {
      hooks.set(hooks.get().map((p) => (p.id === id ? { ...p, ...server } : p)));
    }
    const final = hooks.get().find((p) => p.id === id);
    if (final) hooks.onSuccess?.(final);
    return true;
  } catch (err) {
    hooks.set(before);
    hooks.onError?.(err);
    return false;
  }
}
