import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/services/api', () => ({ default: { get, post, delete: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { useStrategyBuilderStore, toSavePayload, fromApiStrategy } from './strategy-builder-store';

describe('strategy builder save — API contract (POST /api/strategies/save)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({ data: { id: 'srv-1' } });
  });

  it('posts to /strategies/save with `type` (not `mode`) and array timeframes/segments', async () => {
    useStrategyBuilderStore.setState({
      name: 'My ORB',
      description: 'd',
      code: '@strategy("My ORB")',
      mode: 'script',
      timeframe: '5m',
      segment: 'FUTURES',
    });
    await useStrategyBuilderStore.getState().saveStrategy();

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/strategies/save');
    expect(body).toMatchObject({
      name: 'My ORB',
      type: 'script',
      code: '@strategy("My ORB")',
      timeframes: ['5m'],
      segments: ['FUTURES'],
    });
    expect(body).not.toHaveProperty('mode');
    expect(body).not.toHaveProperty('timeframe');
    expect(get).toHaveBeenCalledWith('/strategies');
  });

  it('round-trips: saved payload -> stored row -> list row -> loadStrategy restores the builder', () => {
    const indicators = [{ id: 'i1', name: 'RSI', params: { period: 14 } }] as any;
    const entryRules = [{ id: 'r1', conditions: [], logic: 'AND' }] as any;
    const payload = toSavePayload({
      name: ' Visual one ',
      description: 'vis',
      code: '',
      mode: 'visual',
      timeframe: '15m',
      segment: 'OPTIONS',
      instrument: 'BANKNIFTY',
      indicators,
      entryRules,
      exitRules: [],
    });
    // The API stores the DTO as-is and adds id + timestamps.
    const stored = { ...payload, id: 'abc', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
    const row = fromApiStrategy(stored);
    expect(row).toMatchObject({
      id: 'abc',
      name: 'Visual one',
      mode: 'visual',
      timeframe: '15m',
      segment: 'OPTIONS',
    });

    useStrategyBuilderStore.getState().loadStrategy(row);
    const st = useStrategyBuilderStore.getState();
    expect(st.mode).toBe('visual');
    expect(st.instrument).toBe('BANKNIFTY');
    expect(st.indicators).toEqual(indicators);
    expect(st.entryRules).toEqual(entryRules);
  });

  it('validate sends the `type` the API DTO requires', async () => {
    post.mockResolvedValueOnce({ data: { valid: true, items: [] } });
    useStrategyBuilderStore.setState({ mode: 'script', code: '@strategy("x")' });
    await useStrategyBuilderStore.getState().validateStrategy();
    expect(post).toHaveBeenCalledWith('/strategies/validate', { code: '@strategy("x")', type: 'script' });
  });
});
