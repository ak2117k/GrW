import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('./api', () => ({ default: { get: (...a: unknown[]) => get(...a), post: vi.fn() } }));

import { getLatestInsight } from './insights';

describe('getLatestInsight', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('treats the empty 200 body ("never asked") as no insight', async () => {
    get.mockResolvedValue({ data: '' });
    const r = await getLatestInsight('options-chain', 'NIFTY:2026-10-27');
    expect(r).toBeNull();
    expect(get).toHaveBeenCalledWith('/insights/options-chain/NIFTY%3A2026-10-27');
  });

  it('still treats a 404 from an older API as no insight', async () => {
    get.mockImplementation(async () => {
      throw Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } });
    });
    const r = await getLatestInsight('options-chain', 'NIFTY:2026-10-27');
    expect(r).toBeNull();
  });

  it('returns the row when there is one', async () => {
    get.mockResolvedValue({ data: { id: 'x', status: 'completed' } });
    await expect(getLatestInsight('news-feed', 'a,b')).resolves.toMatchObject({ id: 'x' });
  });
});
