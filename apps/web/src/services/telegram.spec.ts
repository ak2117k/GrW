import { vi, it, expect } from 'vitest';
vi.mock('./api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [{ channelId: 'c1' }] }) } }));
import api from './api';
import { getLeaderboard } from './telegram';

it('getLeaderboard hits /telegram/leaderboard', async () => {
  const r = await getLeaderboard();
  expect((api as any).get).toHaveBeenCalledWith('/telegram/leaderboard');
  expect(r[0].channelId).toBe('c1');
});
