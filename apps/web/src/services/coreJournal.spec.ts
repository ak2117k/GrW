import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import api from './api';
import { ackReconFinding, getCoreComparison, getCoreJournalDay, getCoreJournalStatus, getCorePositionTimeline } from './coreJournal';

describe('coreJournal wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the day (optionally a given day), a position timeline (encoded id), the status and the comparison', async () => {
    (api.get as Mock).mockResolvedValue({ data: { ok: true } });
    await getCoreJournalDay();
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/day', { params: {} });
    await getCoreJournalDay('2026-10-13');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/day', { params: { day: '2026-10-13' } });
    await getCorePositionTimeline('pos/1');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/positions/pos%2F1');
    await getCoreJournalStatus();
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/status');
    await getCoreComparison('2026-10-13');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/comparison', { params: { day: '2026-10-13' } });
  });

  it('acknowledges a finding with its reason', async () => {
    (api.post as Mock).mockResolvedValueOnce({ data: { acknowledged: 'jr_9' } });
    expect(await ackReconFinding('jr_9', 'checked')).toEqual({ acknowledged: 'jr_9' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/journal/recon/jr_9/ack', { reason: 'checked' });
  });
});
