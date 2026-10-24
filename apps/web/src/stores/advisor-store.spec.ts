import { beforeEach, describe, expect, it, vi } from 'vitest';

const { del } = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('@/services/api', () => ({ default: { delete: del, get: vi.fn(), post: vi.fn() } }));

import { useAdvisorStore } from './advisor-store';

describe('advisor store — New chat', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the server-side memory and the visible thread', async () => {
    del.mockResolvedValueOnce({ data: { cleared: 4 } });
    useAdvisorStore.setState({ messages: [{ id: '1', role: 'user', content: 'q', timestamp: new Date() }] });
    await useAdvisorStore.getState().newChat();
    expect(del).toHaveBeenCalledWith('/advisor/conversation');
    expect(useAdvisorStore.getState().messages).toEqual([]);
  });

  it('still clears the thread when the server call fails', async () => {
    del.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useAdvisorStore.setState({ messages: [{ id: '1', role: 'user', content: 'q', timestamp: new Date() }] });
    await useAdvisorStore.getState().newChat();
    expect(useAdvisorStore.getState().messages).toEqual([]);
  });
});
