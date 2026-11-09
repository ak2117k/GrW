import { describe, expect, it, vi } from 'vitest';
import { fetchIndicators, INDICATORS_TIMEOUT_MS } from './fetchIndicators';

const reading = { rsi14: 50 } as never;
const noWait = async () => undefined;
const live = () => false;

describe('fetchIndicators', () => {
  it('allows longer than the 30 s default (prod 2026-11-09: 63 s and 116 s on a first open)', async () => {
    const get = vi.fn().mockResolvedValue({ data: { indicators: reading } });
    await expect(fetchIndicators(get, { token: '3563', exchange: 'NSE', timeframe: '15m' }, live, noWait)).resolves.toBe(reading);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]).toEqual({ params: { token: '3563', exchange: 'NSE', timeframe: '15m' }, timeout: INDICATORS_TIMEOUT_MS });
    expect(INDICATORS_TIMEOUT_MS).toBeGreaterThan(116_000);
  });
  it('tries again after a failure or an empty answer: the chart may have stored the candles by then', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ data: { indicators: null } }).mockResolvedValue({ data: { indicators: reading } });
    await expect(fetchIndicators(get, { token: '1', exchange: 'NSE', timeframe: '15m' }, live, noWait)).resolves.toBe(reading);
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('gives up after three tries', async () => {
    const get = vi.fn().mockResolvedValue({ data: { indicators: null } });
    await expect(fetchIndicators(get, { token: '1', exchange: 'NSE', timeframe: '15m' }, live, noWait)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('stops when the page moved to another symbol', async () => {
    const get = vi.fn().mockResolvedValue({ data: { indicators: null } });
    await fetchIndicators(get, { token: '1', exchange: 'NSE', timeframe: '15m' }, () => true, noWait);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
