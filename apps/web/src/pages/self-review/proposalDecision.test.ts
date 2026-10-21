import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TuningProposal } from '@/types/selfReview.types';

vi.mock('@/services/selfReview', () => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

import { approveProposal, rejectProposal } from '@/services/selfReview';
import { decideProposal, withStatus } from './proposalDecision';

const approve = vi.mocked(approveProposal);
const reject = vi.mocked(rejectProposal);

const proposal = (id: string, status = 'PENDING'): TuningProposal => ({
  id,
  key: `k-${id}`,
  target: 'scorecard.factor.news.weight',
  currentValue: 1,
  proposedValue: 0.5,
  rationale: 'news factor hit rate 38% over 20 sessions',
  evidence: { n: 13, right: 5, wrong: 8 },
  status,
  createdAt: '2026-10-20T11:35:00Z',
  decidedAt: null,
  decidedBy: null,
});

function store(initial: TuningProposal[]) {
  let list = initial;
  const history: string[][] = [];
  return {
    get: () => list,
    set: (next: TuningProposal[]) => {
      list = next;
      history.push(next.map((p) => `${p.id}:${p.status}`));
    },
    history,
  };
}

describe('withStatus', () => {
  it('replaces only the matching proposal', () => {
    const out = withStatus([proposal('a'), proposal('b')], 'b', 'REJECTED', 'now');
    expect(out.map((p) => p.status)).toEqual(['PENDING', 'REJECTED']);
    expect(out[1].decidedAt).toBe('now');
  });
});

describe('decideProposal', () => {
  beforeEach(() => {
    approve.mockReset();
    reject.mockReset();
  });

  it('approve: optimistic APPROVED first, then the server row (APPLIED), success callback', async () => {
    approve.mockResolvedValue({ ...proposal('a'), status: 'APPLIED', decidedBy: 'owner' });
    const s = store([proposal('a'), proposal('b')]);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const ok = await decideProposal('a', 'approve', { ...s, onSuccess, onError, now: () => 'T' });
    expect(ok).toBe(true);
    expect(approve).toHaveBeenCalledWith('a');
    expect(reject).not.toHaveBeenCalled();
    expect(s.history[0]).toEqual(['a:APPROVED', 'b:PENDING']);
    expect(s.get()[0].status).toBe('APPLIED');
    expect(s.get()[0].decidedBy).toBe('owner');
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', status: 'APPLIED' }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('reject with an empty response keeps the optimistic REJECTED', async () => {
    reject.mockResolvedValue(undefined);
    const s = store([proposal('a')]);
    const onSuccess = vi.fn();
    const ok = await decideProposal('a', 'reject', { ...s, onSuccess });
    expect(ok).toBe(true);
    expect(reject).toHaveBeenCalledWith('a');
    expect(s.get()[0].status).toBe('REJECTED');
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
  });

  it('rolls back to the previous list and reports the error when the API fails', async () => {
    const err = new Error('403');
    approve.mockRejectedValue(err);
    const before = [proposal('a'), proposal('b')];
    const s = store(before);
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const ok = await decideProposal('a', 'approve', { ...s, onError, onSuccess });
    expect(ok).toBe(false);
    expect(s.history[0]).toEqual(['a:APPROVED', 'b:PENDING']);
    expect(s.get()).toBe(before);
    expect(onError).toHaveBeenCalledWith(err);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
